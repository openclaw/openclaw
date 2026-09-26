import { EventEmitter } from "node:events";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedRaftAccount } from "./accounts.js";
import { startRaftGatewayAccount } from "./gateway.js";

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

  spawn = (params: { endpoint: string; token: string }) => {
    this.started.resolve(params);
    return this;
  };
}

const tempWorkspaces: TempWorkspaceSync[] = [];

function createContext(accountId = "default") {
  const controller = new AbortController();
  const status = {
    accountId,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  const run = vi.fn(
    async (params: {
      raw: unknown;
      adapter: {
        ingest: (raw: unknown) => {
          id: string;
          timestamp: number;
          rawText: string;
          textForAgent: string;
          textForCommands: string;
        };
        resolveTurn: (input: {
          id: string;
          timestamp: number;
          rawText: string;
          textForAgent: string;
          textForCommands: string;
        }) => Promise<{
          delivery: {
            deliver: () => Promise<{ visibleReplySent: false }>;
          };
        }>;
      };
    }) => {
      const input = params.adapter.ingest(params.raw);
      const turn = await params.adapter.resolveTurn(input);
      await turn.delivery.deliver();
    },
  );
  const buildContext = vi.fn(() => ({}));
  const ctx = {
    cfg: {},
    accountId,
    account: {
      accountId,
      name: null,
      enabled: true,
      configured: true,
      profile: "openclaw",
    },
    runtime: {},
    abortSignal: controller.signal,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getStatus: () => status,
    setStatus: (next: typeof status & Record<string, unknown>) => {
      Object.assign(status, next);
    },
    channelRuntime: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          sessionKey: `agent:main:raft:${accountId}`,
        })),
      },
      inbound: {
        run,
        buildContext,
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/openclaw-agent.sqlite"),
        recordInboundSession: vi.fn(),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
    },
  };
  return {
    ctx: ctx as unknown as ChannelGatewayContext<ResolvedRaftAccount>,
    controller,
    run,
    buildContext,
    wakeDedupe: createChannelReplayGuard<{ accountId: string; key: string }>({
      dedupe: { ttlMs: 0, memoryMaxSize: 10_000 },
      buildReplayKey: (event) => event.key,
      namespace: (event) => event.accountId,
    }),
  };
}

async function withGateway(
  { ctx, controller, wakeDedupe }: ReturnType<typeof createContext>,
  test: (connection: {
    endpoint: string;
    token: string;
    post: (body?: unknown, authToken?: string) => Promise<Response>;
  }) => Promise<void>,
) {
  const bridge = new FakeBridge();
  const start = startRaftGatewayAccount(ctx, { spawnBridge: bridge.spawn, wakeDedupe });
  void start.catch(bridge.started.reject);
  try {
    const { endpoint, token } = await withTimeout(
      bridge.started.promise,
      500,
      "Raft bridge startup",
    );
    await test({
      endpoint,
      token,
      post: (body, authToken = token) =>
        fetch(endpoint, {
          method: "POST",
          headers: { "x-raft-bridge-token": authToken },
          body: JSON.stringify(body),
        }),
    });
  } finally {
    controller.abort();
    await start;
  }
  return bridge;
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

afterEach(() => {
  processRuntimeMocks.killProcessTree.mockReset();
  resetPluginStateStoreForTests();
  for (const workspace of tempWorkspaces.splice(0)) {
    workspace.cleanup();
  }
  vi.restoreAllMocks();
});

describe("Raft wake gateway", () => {
  it.each(["claim", "commit"] as const)(
    "joins an admitted wake during shutdown while %s is pending",
    async (phase) => {
      const { ctx, controller, run, wakeDedupe } = createContext();
      const bridge = new FakeBridge();
      const pending = createDeferred<void>();
      const reached = createDeferred<void>();
      let processing: Promise<unknown> | undefined;
      const processGuarded = wakeDedupe.processGuarded.bind(wakeDedupe);
      wakeDedupe.processGuarded = (event, process, options) => {
        const operation = processGuarded(
          event,
          async () => {
            if (phase === "claim") {
              reached.resolve();
              await pending.promise;
            }
            const result = await process();
            if (phase === "commit") {
              reached.resolve();
              await pending.promise;
            }
            return result;
          },
          options,
        );
        processing = operation;
        return operation;
      };
      let stopped = false;
      const start = startRaftGatewayAccount(ctx, { wakeDedupe, spawnBridge: bridge.spawn }).finally(
        () => {
          stopped = true;
        },
      );
      try {
        const { endpoint, token } = await bridge.started.promise;
        const request = fetch(endpoint, {
          method: "POST",
          headers: { "x-raft-bridge-token": token },
          body: JSON.stringify({ eventId: "wake-settlement" }),
        }).catch(() => undefined);
        await reached.promise;
        controller.abort();
        await request;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(stopped).toBe(false);
        pending.resolve();
        await start;
        expect(run).toHaveBeenCalledTimes(phase === "commit" ? 1 : 0);
      } finally {
        pending.resolve();
        controller.abort();
        await start;
        await processing?.catch(() => undefined);
      }
    },
  );

  it("keeps a disabled account quiescent until shutdown", async () => {
    const { ctx, controller, wakeDedupe } = createContext();
    ctx.account.enabled = false;
    const spawnBridge = vi.fn(() => new FakeBridge());
    let settled = false;
    const start = startRaftGatewayAccount(ctx, { spawnBridge, wakeDedupe }).then(() => {
      settled = true;
    });

    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(settled).toBe(false);
      expect(spawnBridge).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await start;
    }
  });

  it("keeps delivering 413 for an over-limit wake payload and closing the connection", async () => {
    const fixture = createContext();
    await withGateway(fixture, async ({ endpoint, token }) => {
      // Declared and sent in one write: the shape whose rejection used to race the flush.
      const result = await postRawWebhook({
        url: endpoint,
        body: JSON.stringify({ deliveryId: "x".repeat(16 * 1024) }),
        headers: {
          "content-type": "application/json",
          "x-raft-bridge-token": token,
        },
      });

      expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
      expect(JSON.parse(result.body)).toEqual({
        error: "Wake payload exceeds the 16 KiB limit.",
      });
      expect(result.closedByServer).toBe(true);
      expect(fixture.run).not.toHaveBeenCalled();
    });
  });

  it("accepts authenticated content-free wake hints and dedupes retry delivery ids", async () => {
    const fixture = createContext();
    const { ctx, run, buildContext } = fixture;
    ctx.account.profile = "main'; touch /tmp/pwn; echo '";
    const bridge = await withGateway(fixture, async ({ endpoint, token, post }) => {
      expect(ctx.getStatus()).toMatchObject({
        running: true,
        connected: true,
        lifecycle: "ready",
        lastConnectedAt: expect.any(Number),
        lastError: null,
        terminalDisconnect: undefined,
      });
      await expect(fetch(endpoint.replace("/wake", "/health"))).resolves.toMatchObject({
        status: 200,
      });
      await expect(fetch(endpoint, { method: "POST" })).resolves.toMatchObject({ status: 401 });
      await expect(post(undefined, "x".repeat(token.length))).resolves.toMatchObject({
        status: 401,
      });
      await expect(post(undefined, "short")).resolves.toMatchObject({ status: 401 });
      await expect(post()).resolves.toMatchObject({ status: 400 });
      await expect(
        post({ eventId: "wake-content", metadata: { text: "not a wake hint" } }),
      ).resolves.toMatchObject({ status: 400 });
      const accepted = await post({ eventId: "wake-1", timestamp: 1 });
      expect(accepted.status).toBe(202);
      await expect(accepted.json()).resolves.toMatchObject({
        accepted: true,
        ok: true,
        runtimeSession: expect.any(String),
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(buildContext).toHaveBeenCalledWith(
        expect.objectContaining({ channelIngress: "unsupported" }),
      );

      const drainUrl = endpoint.replace("/wake", "/activity/drain?max=50");
      await expect(fetch(drainUrl)).resolves.toMatchObject({ status: 401 });
      const drain = await fetch(drainUrl, { headers: { "x-raft-bridge-token": token } });
      expect(drain.status).toBe(200);
      await expect(drain.json()).resolves.toEqual({
        dropped: 0,
        events: [],
        schema: "raft-activity-drain.v1",
      });
      await expect(post({ eventId: "wake-1", timestamp: 2 })).resolves.toMatchObject({
        status: 202,
      });
      expect(run).toHaveBeenCalledTimes(1);
      await expect(post({ metadata: { sequence: 1, source: "bridge" } })).resolves.toMatchObject({
        status: 400,
      });
      expect(run).toHaveBeenCalledTimes(1);

      const input = run.mock.calls[0]?.[0].adapter.ingest({ kind: "wake" });
      expect(input?.textForAgent).toContain(
        `raft --profile 'main'"'"'; touch /tmp/pwn; echo '"'"'' message check`,
      );
      expect(input?.rawText).not.toContain("wake-1");
    });
    expect(processRuntimeMocks.killProcessTree).toHaveBeenCalledOnce();
    expect(processRuntimeMocks.killProcessTree).toHaveBeenCalledWith(bridge.pid, {
      graceMs: 5_000,
      detached: process.platform !== "win32",
    });
  });

  it("keeps a failed delivery eligible for a bridge retry", async () => {
    const fixture = createContext();
    await withGateway(fixture, async ({ post }) => {
      fixture.run.mockRejectedValueOnce(new Error("inbound runtime unavailable"));
      await expect(post({ eventId: "wake-retry" })).resolves.toMatchObject({ status: 500 });
      await expect(post({ eventId: "wake-retry" })).resolves.toMatchObject({ status: 202 });
      expect(fixture.run).toHaveBeenCalledTimes(2);
    });
  });

  it("persists accepted wake dedupe across restarts without crossing accounts", async () => {
    const workspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-raft-wake-dedupe-",
    });
    tempWorkspaces.push(workspace);
    for (const [accountId, expectedCalls] of [
      ["default", 1],
      ["default", 0],
      ["other", 1],
    ] as const) {
      const fixture = createContext(accountId);
      fixture.wakeDedupe = createPersistentWakeDedupe(workspace.dir);
      await withGateway(fixture, async ({ post }) => {
        await expect(post({ eventId: "wake-persisted" })).resolves.toMatchObject({ status: 202 });
        expect(fixture.run).toHaveBeenCalledTimes(expectedCalls);
      });
    }
  });
});
