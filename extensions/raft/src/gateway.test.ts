import { ChildProcess } from "node:child_process";
import { setImmediate, setTimeout } from "node:timers/promises";
import type {
  ChannelInboundEventRunnerParams,
  InboundReplyDispatchResult,
} from "openclaw/plugin-sdk/channel-inbound";
import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as replay from "openclaw/plugin-sdk/persistent-dedupe";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  killProcessTree,
  spawnOomScoreAdjusted as spawn,
} from "openclaw/plugin-sdk/process-runtime";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { createFixtureLifetime, postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { startRaftGatewayAccount } from "./gateway.js";
import { dispatchRaftWake } from "./inbound.js";

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  killProcessTree: vi.fn(),
  spawnOomScoreAdjusted: vi.fn(),
}));

const tempWorkspaces: TempWorkspaceSync[] = [];
type WakeEvent = { accountId: string; key: string };
type Scenario = ReturnType<typeof createScenario>;
const scenarios: Scenario[] = [];

function createScenario() {
  const lifetime = createFixtureLifetime();
  const cancellation = new AbortController();
  const retirement = new Error("Raft fixture retired");
  const releases: (() => void)[] = [];
  let retired = false;
  const assertActive = () => {
    if (retired) {
      throw retirement;
    }
  };
  return {
    lifetime,
    assertActive,
    wait: <T>(pending: Promise<T>) => lifetime.track(withinTest(pending, cancellation.signal)),
    onRetire: (release: () => void) => {
      assertActive();
      releases.push(release);
    },
    retire: async () => {
      retired = true;
      cancellation.abort(retirement);
      const results = await Promise.allSettled(releases.map(async (release) => release()));
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) {
        throw new AggregateError(failures, "Raft fixture retirement failed");
      }
    },
  };
}

function runScenario(body: (scope: Scenario) => Promise<void>) {
  const scope = createScenario();
  scenarios.push(scope);
  return scope.lifetime.run(() => {
    scope.assertActive();
    return body(scope);
  });
}

function createContext(accountId = "default", stateDir?: string) {
  const controller = new AbortController();
  const run = vi
    .fn<
      (
        params: ChannelInboundEventRunnerParams<unknown>,
      ) => Promise<InboundReplyDispatchResult<unknown>>
    >()
    .mockResolvedValue({ admission: { kind: "handled", reason: "fixture" }, dispatched: false });
  const buildContext = vi.fn(() => ({}));
  const ctx = createStartAccountContext({
    account: { accountId, enabled: true, profile: "openclaw", configured: true, name: undefined },
    abortSignal: controller.signal,
  });
  const route = { agentId: "main", sessionKey: `agent:main:raft:${accountId}` };
  const resolveAgentRoute = vi.fn(() => route);
  Object.assign(ctx, {
    channelRuntime: {
      routing: { resolveAgentRoute },
      inbound: { run, buildContext },
    },
  });
  return {
    ctx,
    controller,
    run,
    buildContext,
    route,
    resolveAgentRoute,
    wakeDedupe: replay.createChannelReplayGuard<WakeEvent>({
      dedupe: stateDir
        ? {
            ttlMs: 24 * 60 * 60 * 1000,
            memoryMaxSize: 1_000,
            pluginId: "raft",
            namespacePrefix: "raft-wake-dedupe",
            stateMaxEntries: 10_000,
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          }
        : { ttlMs: 0, memoryMaxSize: 10_000 },
      buildReplayKey: (event) => event.key,
      namespace: (event) => event.accountId,
    }),
  };
}

function startAccount(scope: Scenario, { ctx, controller }: ReturnType<typeof createContext>) {
  scope.assertActive();
  const start = scope.lifetime.track(startRaftGatewayAccount(ctx));
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= scope.lifetime.verifyCleanup(async () => {
      controller.abort();
      await start;
    }));
  scope.onRetire(() => {
    void stop();
  });
  return { start, stop };
}

async function startGateway(scope: Scenario, fixture = createContext()) {
  scope.assertActive();
  const bridge = Object.assign(new ChildProcess(), { pid: 4242 });
  const started = createDeferred<{ endpoint: string; token: string }>();
  scope.onRetire(() => started.reject(new Error("Raft fixture retired before startup")));
  void started.promise.catch(() => {});
  vi.mocked(spawn).mockImplementationOnce((_command, args, options) => {
    scope.assertActive();
    const endpoint = args?.at(-1);
    const token = options?.env?.RAFT_CHANNEL_TOKEN;
    if (!endpoint || !token) {
      throw new Error("Raft bridge spawn omitted its endpoint or token");
    }
    started.resolve({ endpoint, token });
    return bridge;
  });
  vi.spyOn(replay, "createChannelReplayGuard");
  vi.mocked(replay.createChannelReplayGuard<WakeEvent>).mockReturnValueOnce(fixture.wakeDedupe);
  const lifecycle = startAccount(scope, fixture);
  void scope.lifetime.track(lifecycle.start.catch(started.reject));
  const { endpoint, token } = await scope.wait(
    awaitGateBeforeSettlement(
      started.promise,
      lifecycle.start,
      "Raft bridge stopped before startup",
    ),
  );
  const request = (path: string, status: number, init: RequestInit): Promise<unknown> =>
    scope.lifetime.run(async () => {
      scope.assertActive();
      const response = await fetch(new URL(path, endpoint), {
        ...init,
        signal: fixture.controller.signal,
      });
      const body: unknown = await response.json();
      expect(response.status).toBe(status);
      return body;
    });
  const headers = (authToken: string | null): HeadersInit =>
    authToken === null ? {} : { "x-raft-bridge-token": authToken };
  return {
    ...fixture,
    ...lifecycle,
    bridge,
    endpoint,
    token,
    get: (path: string, status = 200, authToken = token) =>
      request(path, status, { headers: headers(authToken) }),
    post: (body?: unknown, status = 202, authToken: string | null = token) =>
      request("/wake", status, {
        method: "POST",
        headers: headers(authToken),
        body: JSON.stringify(body),
      }),
  };
}

afterEach(async () => {
  const scopes = scenarios.splice(0);
  // Retirement releases held gates; ordinary account abort must keep them held.
  const retired = await Promise.allSettled(scopes.map((scope) => scope.retire()));
  const drained = await Promise.allSettled(scopes.map((scope) => scope.lifetime.cleanup()));
  const cleaned = await Promise.allSettled(
    [
      () => vi.mocked(killProcessTree).mockReset(),
      () => vi.mocked(spawn).mockReset(),
      () => resetPluginStateStoreForTests(),
      () => vi.restoreAllMocks(),
      ...tempWorkspaces.splice(0).map((workspace) => () => workspace.cleanup()),
    ].map(async (cleanup) => cleanup()),
  );
  const failures = [...retired, ...drained, ...cleaned].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    throw new AggregateError(failures, "Raft fixture cleanup failed");
  }
});

it.each(["claim", "commit"] as const)(
  "joins an admitted wake during shutdown while %s is pending",
  (phase) =>
    runScenario(async (scope) => {
      const fixture = createContext();
      const { controller, run, wakeDedupe } = fixture;
      const pending = createDeferred<void>();
      const reached = createDeferred<void>();
      // Release the barrier before account cleanup joins its blocked task.
      scope.onRetire(() => pending.resolve());
      const pause = async <T>(result: T) => {
        reached.resolve();
        await pending.promise;
        return result;
      };
      const processGuarded = wakeDedupe.processGuarded.bind(wakeDedupe);
      wakeDedupe.processGuarded = (event, process, options) =>
        scope.lifetime.track(
          processGuarded(
            event,
            phase === "claim" ? () => pause(undefined).then(process) : () => process().then(pause),
            options,
          ),
        );
      const { post, start } = await startGateway(scope, fixture);
      const stopped = vi.fn();
      const settled = scope.lifetime.track(start.finally(stopped));
      const request = scope.lifetime.track(
        post({ eventId: "wake-settlement" }).catch(() => undefined),
      );
      await scope.wait(reached.promise);
      controller.abort();
      await request;
      await setImmediate();
      expect(stopped).not.toHaveBeenCalled();
      pending.resolve();
      await settled;
      expect(run).toHaveBeenCalledTimes(phase === "commit" ? 1 : 0);
    }),
);

it("keeps a disabled account quiescent until shutdown", () =>
  runScenario(async (scope) => {
    const fixture = createContext();
    fixture.ctx.account.enabled = false;
    const settled = vi.fn();
    const { start } = startAccount(scope, fixture);
    void scope.lifetime.track(start.then(settled));
    await setTimeout(0);
    expect(settled).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  }));

it("keeps delivering 413 for an over-limit wake payload and closing the connection", () =>
  runScenario(async (scope) => {
    const { endpoint, token, run } = await startGateway(scope);
    // Declared and sent in one write: the shape whose rejection used to race the flush.
    const result = await scope.lifetime.track(
      postRawWebhook({
        url: endpoint,
        body: JSON.stringify({ deliveryId: "x".repeat(16 * 1024) }),
        headers: {
          "content-type": "application/json",
          "x-raft-bridge-token": token,
        },
      }),
    );

    expect(result).toMatchObject({
      statusLine: "HTTP/1.1 413 Payload Too Large",
      closedByServer: true,
    });
    expect(JSON.parse(result.body)).toEqual({ error: "Wake payload exceeds the 16 KiB limit." });
    expect(run).not.toHaveBeenCalled();
  }));

it("accepts authenticated content-free wake hints and dedupes retry delivery ids", () =>
  runScenario(async (scope) => {
    const fixture = createContext();
    const { ctx, run } = fixture;
    ctx.account.profile = "main'; touch /tmp/pwn; echo '";
    const { token, get, post, bridge, stop } = await startGateway(scope, fixture);
    expect(ctx.getStatus()).toMatchObject({ running: true, connected: true, lifecycle: "ready" });
    await get("/health");
    await post(undefined, 401, null);
    await post(undefined, 401, "x".repeat(token.length));
    await post(undefined, 401, "short");
    await post(undefined, 400);
    expect(
      await post({ eventId: "wake-content", metadata: { text: "not a wake hint" } }, 400),
    ).toEqual({ error: "Wake payload must not include message content." });
    const accepted = await post({ eventId: "wake-1", timestamp: 1 });
    expect(accepted).toMatchObject({
      accepted: true,
      ok: true,
      runtimeSession: expect.any(String),
    });
    expect(run).toHaveBeenCalledTimes(1);

    await get("/activity/drain?max=50", 401, "");
    const drain = await get("/activity/drain?max=50");
    expect(drain).toEqual({ dropped: 0, events: [], schema: "raft-activity-drain.v1" });
    await post({ metadata: { sequence: 1, source: "bridge" } }, 400);
    await post({ eventId: "wake-1", timestamp: 2 });
    expect(run).toHaveBeenCalledTimes(1);

    const input = await run.mock.calls[0]?.[0].adapter.ingest({ kind: "wake" });
    expect(input?.textForAgent).toContain(
      `raft --profile 'main'"'"'; touch /tmp/pwn; echo '"'"'' message check`,
    );
    expect(input?.rawText).not.toContain("wake-1");
    await stop();
    expect(killProcessTree).toHaveBeenCalledOnce();
    expect(killProcessTree).toHaveBeenCalledWith(bridge.pid, {
      graceMs: 5_000,
      detached: process.platform !== "win32",
    });
  }));

it("keeps a failed delivery eligible for a bridge retry", () =>
  runScenario(async (scope) => {
    const { post, run } = await startGateway(scope);
    run.mockRejectedValueOnce(new Error("inbound runtime unavailable"));
    await post({ eventId: "wake-retry" }, 500);
    await post({ eventId: "wake-retry" });
    expect(run).toHaveBeenCalledTimes(2);
  }));

it("persists accepted wake dedupe across restarts without crossing accounts", () =>
  runScenario(async (scope) => {
    const workspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-raft-wake-dedupe-",
    });
    tempWorkspaces.push(workspace);
    const stateDir = workspace.dir;
    for (const phase of ["first", "restart", "other"] as const) {
      const accountId = phase === "other" ? "other" : "default";
      const { post, run, stop } = await startGateway(scope, createContext(accountId, stateDir));
      await post({ eventId: "wake-persisted" });
      expect(run).toHaveBeenCalledTimes(phase === "restart" ? 0 : 1);
      await stop();
    }
  }));

it("maps a content-free wake through the real inbound adapter without channel delivery", () =>
  runScenario(async () => {
    const { ctx, run, buildContext, route, resolveAgentRoute } = createContext("support");
    ctx.account.profile = "support-profile";
    await dispatchRaftWake(ctx);
    expect(resolveAgentRoute).toHaveBeenCalledExactlyOnceWith({
      cfg: ctx.cfg,
      channel: "raft",
      accountId: "support",
      peer: { kind: "direct", id: "support-profile" },
    });
    expect(run).toHaveBeenCalledOnce();
    const dispatch = run.mock.calls[0]![0];
    expect(dispatch).toMatchObject({
      channel: "raft",
      accountId: "support",
      raw: { kind: "wake", profile: "support-profile" },
    });
    const input = await dispatch.adapter.ingest(dispatch.raw);
    expect(input).toEqual({
      id: expect.any(String),
      timestamp: expect.any(Number),
      rawText:
        "Raft wake hint received. Check Raft for pending messages, then reply through the Raft CLI.",
      textForAgent: expect.stringContaining("raft --profile 'support-profile' message check"),
      textForCommands: "",
    });
    if (!input) {
      throw new Error("Raft wake input missing");
    }
    const turn = await dispatch.adapter.resolveTurn(
      input,
      {
        kind: "message",
        canStartAgentTurn: true,
      },
      {},
    );
    expect(buildContext).toHaveBeenCalledExactlyOnceWith({
      channelIngress: "unsupported",
      channel: "raft",
      accountId: "support",
      messageId: input.id,
      timestamp: input.timestamp,
      from: "raft:support-profile",
      sender: { id: "support-profile", name: "Raft" },
      conversation: { kind: "direct", id: "support-profile", label: "Raft support-profile" },
      route: {
        agentId: route.agentId,
        accountId: "support",
        routeSessionKey: route.sessionKey,
        dispatchSessionKey: route.sessionKey,
      },
      reply: { to: "raft:support-profile" },
      message: {
        rawBody: input.rawText,
        commandBody: input.textForCommands,
        bodyForAgent: input.textForAgent,
      },
    });
    if (!("cfg" in turn) || !("delivery" in turn)) {
      throw new Error("Raft delivery adapter missing");
    }
    expect(turn.cfg).toBe(ctx.cfg);
    expect(turn).toMatchObject({ channel: "raft", accountId: "support", route });
    expect(turn.ctxPayload).toBe(buildContext.mock.results[0]!.value);
    await expect(turn.delivery.deliver({ text: "ignored" }, { kind: "final" })).resolves.toEqual({
      visibleReplySent: false,
    });
  }));
