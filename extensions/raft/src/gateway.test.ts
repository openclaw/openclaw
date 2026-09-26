import { EventEmitter } from "node:events";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { createFixtureLifetime, postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedRaftAccount } from "./accounts.js";
import { startRaftGatewayAccount } from "./gateway.js";
import { dispatchRaftWake } from "./inbound.js";

const processRuntimeMocks = vi.hoisted(() => ({
  killProcessTree: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  killProcessTree: processRuntimeMocks.killProcessTree,
}));

class FakeBridge extends EventEmitter {
  pid = 4242;
  readonly started = createDeferred<{ endpoint: string; token: string }>();

  constructor() {
    super();
    void this.started.promise.catch(() => {});
  }

  spawn = vi.fn((params: { endpoint: string; token: string }) => {
    this.started.resolve(params);
    return this;
  });
}

type GatewayOptions = {
  accountId?: string;
  profile?: string;
  enabled?: boolean;
  wakeDedupe?: ReturnType<typeof createPersistentWakeDedupe>;
};

function createContext(options: GatewayOptions = {}) {
  const accountId = options.accountId ?? "default";
  const controller = new AbortController();
  const status = {
    accountId,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  // Transport rows observe registration; the focused adapter row exercises the
  // actual RAFT mapping without copying the core runner's session/dispatch policy.
  const run = vi.fn<PluginRuntime["channel"]["inbound"]["run"]>().mockResolvedValue({
    admission: { kind: "handled", reason: "transport-test" },
    dispatched: false,
  });
  const builtContext = {
    Body: "fixture body",
    BodyForAgent: "fixture agent body",
    BodyForCommands: "",
    ChatType: "direct",
    CommandAuthorized: false,
    CommandBody: "",
    From: "raft:fixture",
    RawBody: "fixture raw body",
    SessionKey: "agent:main:raft:fixture",
    To: "raft:fixture",
    InboundEventKind: "user_request",
  } satisfies Awaited<ReturnType<PluginRuntime["channel"]["inbound"]["buildContext"]>>;
  const buildContext = vi
    .fn<PluginRuntime["channel"]["inbound"]["buildContext"]>()
    .mockReturnValue(builtContext);
  const resolveAgentRoute = vi.fn(() => ({
    agentId: "main",
    sessionKey: "agent:main:raft:" + accountId,
  }));
  const ctx = {
    cfg: {},
    accountId,
    account: {
      accountId,
      name: null,
      enabled: options.enabled ?? true,
      configured: true,
      profile: options.profile ?? "openclaw",
    },
    runtime: {},
    abortSignal: controller.signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getStatus: () => status,
    setStatus: (next: typeof status & Record<string, unknown>) => {
      Object.assign(status, next);
    },
    channelRuntime: {
      routing: { resolveAgentRoute },
      inbound: { run, buildContext },
    },
  };
  return {
    ctx: ctx as unknown as ChannelGatewayContext<ResolvedRaftAccount>,
    controller,
    run,
    buildContext,
    builtContext,
    resolveAgentRoute,
    wakeDedupe:
      options.wakeDedupe ??
      createChannelReplayGuard<{ accountId: string; key: string }>({
        dedupe: { ttlMs: 0, memoryMaxSize: 10_000 },
        buildReplayKey: (event) => event.key,
        namespace: (event) => event.accountId,
      }),
  };
}

function createPersistentWakeDedupe(stateDir: string) {
  return createChannelReplayGuard<{ accountId: string; key: string }>({
    dedupe: {
      ttlMs: 24 * 60 * 60 * 1000,
      memoryMaxSize: 1_000,
      pluginId: "raft",
      namespacePrefix: "raft-wake-dedupe",
      stateMaxEntries: 10_000,
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    },
    buildReplayKey: (event) => event.key,
    namespace: (event) => event.accountId,
  });
}

function createScenarioScope() {
  const lifetime = createFixtureLifetime();
  const stops = new Set<() => void>();
  const cancellation = createDeferred<never>();
  void cancellation.promise.catch(() => {});
  let retiring = false;
  return {
    lifetime,
    stops,
    cancelled: cancellation.promise,
    assertActive() {
      if (retiring) {
        throw new Error("Raft test scenario is retiring.");
      }
    },
    retire() {
      retiring = true;
      cancellation.reject(new Error("Raft test scenario is retiring."));
      for (const stop of stops) {
        stop();
      }
    },
  };
}

const scopes: ReturnType<typeof createScenarioScope>[] = [];
const tempWorkspaces: TempWorkspaceSync[] = [];

function runScenario(body: (scope: ReturnType<typeof createScenarioScope>) => Promise<void>) {
  const scope = createScenarioScope();
  scopes.push(scope);
  return scope.lifetime.run(async () => {
    scope.assertActive();
    await body(scope);
  });
}

function createGateway(
  scope: ReturnType<typeof createScenarioScope>,
  options: GatewayOptions = {},
) {
  scope.assertActive();
  const context = createContext(options);
  const { ctx, controller, wakeDedupe } = context;
  const bridge = new FakeBridge();
  const releases = new Set<() => void>();
  const owned: Promise<unknown>[] = [];
  let retired = false;
  let startup: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  function assertActive() {
    scope.assertActive();
    if (retired) {
      throw new Error("Raft test gateway is retired.");
    }
  }
  function track<T>(operation: Promise<T>, onRejected?: (error: unknown) => void): Promise<T> {
    // Observe immediately, but return the original outcome to the scenario.
    const completion = onRejected ? operation.catch(onRejected) : operation;
    owned.push(scope.lifetime.track(completion, true));
    return operation;
  }
  function retire() {
    if (retired) {
      return;
    }
    retired = true;
    for (const release of releases) {
      release();
    }
    bridge.started.reject(new Error("Raft test gateway retired before startup."));
    controller.abort();
  }
  // Timeout teardown must release gates before lifetime.cleanup joins the body.
  // Deliberate controller.abort() in shutdown rows must leave those gates held.
  scope.stops.add(retire);
  function start() {
    assertActive();
    return (startup ??= track(
      startRaftGatewayAccount(ctx, { wakeDedupe, spawnBridge: bridge.spawn }),
    ));
  }
  function stop() {
    retire();
    return (stopping ??= scope.lifetime.verifyCleanup(async () => {
      await startup?.catch(() => {});
      const results = await Promise.allSettled(owned);
      bridge.removeAllListeners();
      scope.stops.delete(retire);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        throw failed.reason;
      }
    }));
  }
  return {
    ...context,
    bridge,
    track,
    start,
    stop,
    onRetire(release: () => void) {
      assertActive();
      releases.add(release);
    },
    ready() {
      const started = start();
      return scope.lifetime.track(
        withTimeout(
          Promise.race([
            bridge.started.promise,
            started.then(() => {
              throw new Error("Raft gateway stopped before bridge startup.");
            }),
            scope.cancelled,
          ]),
          500,
          "Raft bridge startup",
        ),
      );
    },
    request(url: string, init?: RequestInit, onRejected?: (error: unknown) => void) {
      assertActive();
      return track(
        (async () => {
          const response = await fetch(url, { ...init, signal: controller.signal });
          return { status: response.status, body: await response.text() };
        })(),
        onRejected,
      );
    },
  };
}

async function withGateway(
  scope: ReturnType<typeof createScenarioScope>,
  body: (gateway: ReturnType<typeof createGateway>) => Promise<void>,
  options: GatewayOptions = {},
) {
  const gateway = createGateway(scope, options);
  try {
    await body(gateway);
  } finally {
    await gateway.stop();
  }
}

afterEach(async () => {
  const current = scopes.splice(0);
  for (const scope of current) {
    scope.retire();
  }
  await Promise.all(current.map((scope) => scope.lifetime.cleanup()));
  resetPluginStateStoreForTests();
  for (const workspace of tempWorkspaces.splice(0)) {
    workspace.cleanup();
  }
  processRuntimeMocks.killProcessTree.mockReset();
  vi.restoreAllMocks();
});

describe("Raft wake gateway", () => {
  it.each(["after-claim-before-dispatch", "after-dispatch-before-commit"] as const)(
    "joins an admitted wake during shutdown %s",
    (phase) =>
      runScenario((scope) =>
        withGateway(scope, async (gateway) => {
          const { controller, run, wakeDedupe } = gateway;
          const pending = createDeferred<void>();
          const reached = createDeferred<void>();
          void reached.promise.catch(() => {});
          gateway.onRetire(() => {
            pending.resolve();
            reached.reject(new Error("Raft gateway retired before reaching the held phase."));
          });
          let processing: Promise<unknown> | undefined;
          const processGuarded = wakeDedupe.processGuarded.bind(wakeDedupe);
          wakeDedupe.processGuarded = (event, process, options) => {
            const operation = processGuarded(
              event,
              async () => {
                if (phase === "after-claim-before-dispatch") {
                  reached.resolve();
                  await pending.promise;
                }
                const result = await process();
                if (phase === "after-dispatch-before-commit") {
                  reached.resolve();
                  await pending.promise;
                }
                return result;
              },
              options,
            );
            processing = gateway.track(operation, (error) => {
              expect(phase).toBe("after-claim-before-dispatch");
              expect(error).toMatchObject({
                statusCode: 503,
                message: "Raft Gateway is stopping.",
              });
            });
            return operation;
          };
          let stopped = false;
          const start = gateway.track(
            gateway.start().finally(() => {
              stopped = true;
            }),
          );
          const { endpoint, token } = await gateway.ready();
          const request = gateway.request(
            endpoint,
            {
              method: "POST",
              headers: { "x-raft-bridge-token": token },
              body: JSON.stringify({ eventId: "wake-settlement" }),
            },
            () => {
              expect(controller.signal.aborted).toBe(true);
            },
          );
          await Promise.race([
            reached.promise,
            request.then(() => {
              throw new Error("Raft wake request settled before reaching the held phase.");
            }),
            scope.cancelled,
          ]);
          controller.abort();
          await request.catch(() => {});
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(stopped).toBe(false);
          pending.resolve();
          await start;
          expect(processing).toBeDefined();
          if (phase === "after-claim-before-dispatch") {
            await expect(processing).rejects.toMatchObject({
              statusCode: 503,
              message: "Raft Gateway is stopping.",
            });
          } else {
            await processing;
          }
          expect(run).toHaveBeenCalledTimes(phase === "after-dispatch-before-commit" ? 1 : 0);
        }),
      ),
  );

  it("maps the wake through the actual unsupported-ingress adapter without visible delivery", () =>
    runScenario(async () => {
      const { ctx, run, buildContext, builtContext, resolveAgentRoute } = createContext({
        accountId: "support",
        profile: "main'; touch /tmp/pwn; echo '",
      });
      await dispatchRaftWake({ ctx });
      expect(resolveAgentRoute).toHaveBeenCalledExactlyOnceWith({
        cfg: ctx.cfg,
        channel: "raft",
        accountId: "support",
        peer: { kind: "direct", id: "main'; touch /tmp/pwn; echo '" },
      });
      expect(run).toHaveBeenCalledExactlyOnceWith({
        channel: "raft",
        accountId: "support",
        raw: { kind: "wake", profile: "main'; touch /tmp/pwn; echo '" },
        adapter: { ingest: expect.any(Function), resolveTurn: expect.any(Function) },
      });
      const [registration] = run.mock.calls[0]!;
      const input = await registration.adapter.ingest(registration.raw);
      const textForAgent =
        "Raft wake hint received. Check Raft for pending messages, then reply through the Raft CLI.\n\nUse `raft --profile 'main'\"'\"'; touch /tmp/pwn; echo '\"'\"'' message check` to read pending messages and `raft --profile 'main'\"'\"'; touch /tmp/pwn; echo '\"'\"'' message send` to respond.";
      expect(input).toEqual({
        id: expect.any(String),
        timestamp: expect.any(Number),
        rawText:
          "Raft wake hint received. Check Raft for pending messages, then reply through the Raft CLI.",
        textForAgent,
        textForCommands: "",
      });
      if (!input) {
        throw new Error("Raft wake adapter did not ingest its registered input.");
      }
      const turn = await registration.adapter.resolveTurn(
        input,
        { kind: "message", canStartAgentTurn: true },
        {},
      );
      expect(buildContext).toHaveBeenCalledExactlyOnceWith({
        channelIngress: "unsupported",
        channel: "raft",
        accountId: "support",
        messageId: input.id,
        timestamp: input.timestamp,
        from: "raft:main'; touch /tmp/pwn; echo '",
        sender: { id: "main'; touch /tmp/pwn; echo '", name: "Raft" },
        conversation: {
          kind: "direct",
          id: "main'; touch /tmp/pwn; echo '",
          label: "Raft main'; touch /tmp/pwn; echo '",
        },
        route: {
          agentId: "main",
          accountId: "support",
          routeSessionKey: "agent:main:raft:support",
          dispatchSessionKey: "agent:main:raft:support",
        },
        reply: { to: "raft:main'; touch /tmp/pwn; echo '" },
        message: {
          rawBody:
            "Raft wake hint received. Check Raft for pending messages, then reply through the Raft CLI.",
          commandBody: "",
          bodyForAgent: textForAgent,
        },
      });
      expect(turn).toEqual({
        cfg: ctx.cfg,
        channel: "raft",
        accountId: "support",
        route: { agentId: "main", sessionKey: "agent:main:raft:support" },
        ctxPayload: builtContext,
        delivery: { deliver: expect.any(Function) },
        record: { onRecordError: expect.any(Function) },
      });
      expect(turn.ctxPayload).toBe(builtContext);
      if (!("cfg" in turn) || !("delivery" in turn) || !turn.delivery?.deliver) {
        throw new Error("Raft wake adapter did not resolve its routed delivery contract.");
      }
      expect(turn.cfg).toBe(ctx.cfg);
      await expect(
        turn.delivery.deliver({ text: "agent reply" }, { kind: "final" }),
      ).resolves.toEqual({
        visibleReplySent: false,
      });
    }));

  it("keeps a disabled account quiescent until shutdown", () =>
    runScenario((scope) =>
      withGateway(
        scope,
        async (gateway) => {
          let settled = false;
          gateway.track(
            gateway.start().then(() => {
              settled = true;
            }),
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(settled).toBe(false);
          expect(gateway.bridge.spawn).not.toHaveBeenCalled();
        },
        { enabled: false },
      ),
    ));

  // Observe the raw close before fixture retirement can destroy the accepted socket.
  it("keeps delivering 413 for an over-limit wake payload and closing the connection", () =>
    runScenario((scope) =>
      withGateway(scope, async (gateway) => {
        const { endpoint, token } = await gateway.ready();
        const result = await gateway.track(
          postRawWebhook({
            url: endpoint,
            body: JSON.stringify({
              eventId: "wake-oversize-raw",
              padding: "x".repeat(16 * 1024),
            }),
            headers: {
              "content-type": "application/json",
              "x-raft-bridge-token": token,
            },
          }),
        );
        expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
        expect(JSON.parse(result.body)).toEqual({
          error: "Wake payload exceeds the 16 KiB limit.",
        });
        expect(result.closedByServer).toBe(true);
        expect(gateway.run).not.toHaveBeenCalled();
      }),
    ));

  it("accepts authenticated content-free wake hints and dedupes retry delivery ids", () =>
    runScenario(async (scope) => {
      await withGateway(scope, async (gateway) => {
        const { ctx, run } = gateway;
        const { endpoint, token } = await gateway.ready();
        expect(ctx.getStatus()).toMatchObject({
          running: true,
          connected: true,
          lifecycle: "ready",
          lastConnectedAt: expect.any(Number),
          lastError: null,
          terminalDisconnect: undefined,
        });
        await expect(gateway.request(endpoint.replace("/wake", "/health"))).resolves.toMatchObject({
          status: 200,
        });
        await expect(gateway.request(endpoint, { method: "POST" })).resolves.toMatchObject({
          status: 401,
        });
        await expect(
          gateway.request(endpoint, {
            method: "POST",
            headers: { "x-raft-bridge-token": "x".repeat(token.length) },
          }),
        ).resolves.toMatchObject({ status: 401 });
        await expect(
          gateway.request(endpoint, {
            method: "POST",
            headers: { "x-raft-bridge-token": "short" },
          }),
        ).resolves.toMatchObject({ status: 401 });
        await expect(
          gateway.request(endpoint, {
            method: "POST",
            headers: { "x-raft-bridge-token": token },
          }),
        ).resolves.toMatchObject({ status: 400 });
        const forbidden = await gateway.request(endpoint, {
          method: "POST",
          headers: { "x-raft-bridge-token": token },
          body: JSON.stringify({
            eventId: "wake-forbidden-nested",
            metadata: { text: "not a wake hint" },
          }),
        });
        expect(forbidden.status).toBe(400);
        expect(JSON.parse(forbidden.body)).toEqual({
          error: "Wake payload must not include message content.",
        });
        expect(run).not.toHaveBeenCalled();
        await expect(
          gateway.request(endpoint, {
            method: "POST",
            headers: { "x-raft-bridge-token": token },
            body: JSON.stringify({ eventId: "wake-1", timestamp: 1 }),
          }),
        ).resolves.toMatchObject({ status: 202 });
        await expect(
          gateway.request(endpoint.replace("/wake", "/activity/drain?max=50")),
        ).resolves.toMatchObject({ status: 401 });
        await expect(
          gateway.request(endpoint.replace("/wake", "/activity/drain?max=50"), {
            headers: { "x-raft-bridge-token": token },
          }),
        ).resolves.toMatchObject({ status: 200 });
        const drain = await gateway.request(endpoint.replace("/wake", "/activity/drain?max=50"), {
          headers: { "x-raft-bridge-token": token },
        });
        expect(JSON.parse(drain.body)).toEqual({
          dropped: 0,
          events: [],
          schema: "raft-activity-drain.v1",
        });
        // A 202 follows the queued processGuarded settlement, so no later poll is needed.
        expect(run).toHaveBeenCalledExactlyOnceWith({
          channel: "raft",
          accountId: "default",
          raw: { kind: "wake", profile: "openclaw" },
          adapter: { ingest: expect.any(Function), resolveTurn: expect.any(Function) },
        });
        await expect(
          gateway.request(endpoint, {
            method: "POST",
            headers: { "x-raft-bridge-token": token },
            body: JSON.stringify({ eventId: "wake-1", timestamp: 2 }),
          }),
        ).resolves.toMatchObject({ status: 202 });
        expect(run).toHaveBeenCalledTimes(1);
        await expect(
          gateway.request(endpoint, {
            method: "POST",
            headers: { "x-raft-bridge-token": token },
            body: JSON.stringify({ metadata: { sequence: 1, source: "bridge" } }),
          }),
        ).resolves.toMatchObject({ status: 400 });
        expect(run).toHaveBeenCalledTimes(1);
      });
      expect(processRuntimeMocks.killProcessTree).toHaveBeenCalledExactlyOnceWith(4242, {
        graceMs: 5_000,
        detached: process.platform !== "win32",
      });
    }));

  it("returns the Raft bridge runtime session for accepted wakes", () =>
    runScenario((scope) =>
      withGateway(scope, async (gateway) => {
        const { endpoint, token } = await gateway.ready();
        const response = await gateway.request(endpoint, {
          method: "POST",
          headers: { "x-raft-bridge-token": token },
          body: JSON.stringify({ eventId: "wake-runtime-session" }),
        });
        expect(response.status).toBe(202);
        expect(JSON.parse(response.body)).toMatchObject({
          accepted: true,
          ok: true,
          runtimeSession: expect.any(String),
        });
      }),
    ));

  it("rejects oversized payloads before queueing a wake", () =>
    runScenario((scope) =>
      withGateway(scope, async (gateway) => {
        const { endpoint, token } = await gateway.ready();
        await expect(
          gateway.request(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-raft-bridge-token": token,
            },
            body: JSON.stringify({
              eventId: "wake-oversize-fetch",
              padding: "x".repeat(17 * 1024),
            }),
          }),
        ).resolves.toMatchObject({ status: 413 });
        expect(gateway.run).not.toHaveBeenCalled();
      }),
    ));

  it("keeps a failed delivery eligible for a bridge retry", () =>
    runScenario((scope) =>
      withGateway(scope, async (gateway) => {
        const { endpoint, token } = await gateway.ready();
        gateway.run.mockRejectedValueOnce(new Error("inbound runtime unavailable"));
        const request = () => ({
          method: "POST",
          headers: { "x-raft-bridge-token": token },
          body: JSON.stringify({ eventId: "wake-retry" }),
        });
        await expect(gateway.request(endpoint, request())).resolves.toMatchObject({ status: 500 });
        await expect(gateway.request(endpoint, request())).resolves.toMatchObject({ status: 202 });
        expect(gateway.run).toHaveBeenCalledTimes(2);
      }),
    ));

  it("persists accepted wake dedupe across restarts without crossing accounts", () =>
    runScenario(async (scope) => {
      const workspace = tempWorkspaceSync({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "openclaw-raft-wake-dedupe-",
      });
      tempWorkspaces.push(workspace);
      for (const { accountId, calls } of [
        { accountId: "default", calls: 1 },
        { accountId: "default", calls: 0 },
        { accountId: "other", calls: 1 },
      ]) {
        scope.assertActive();
        await withGateway(
          scope,
          async (gateway) => {
            const { endpoint, token } = await gateway.ready();
            await expect(
              gateway.request(endpoint, {
                method: "POST",
                headers: { "x-raft-bridge-token": token },
                body: JSON.stringify({ eventId: "wake-persisted" }),
              }),
            ).resolves.toMatchObject({ status: 202 });
            expect(gateway.run).toHaveBeenCalledTimes(calls);
          },
          { accountId, wakeDedupe: createPersistentWakeDedupe(workspace.dir) },
        );
      }
    }));
});
