import { ChildProcess } from "node:child_process";
import { setImmediate, setTimeout } from "node:timers/promises";
import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
} from "openclaw/plugin-sdk/channel-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { spawnOomScoreAdjusted as spawn } from "openclaw/plugin-sdk/process-runtime";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspaceSync,
  type TempWorkspaceSync,
} from "openclaw/plugin-sdk/temp-path";
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, expect, it, vi } from "vitest";
import type { ResolvedRaftAccount } from "./accounts.js";
import { startRaftGatewayAccount } from "./gateway.js";

const processRuntimeMocks = vi.hoisted(() => ({
  killProcessTree: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  killProcessTree: processRuntimeMocks.killProcessTree,
  spawnOomScoreAdjusted: processRuntimeMocks.spawn,
}));

vi.mock("openclaw/plugin-sdk/persistent-dedupe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/persistent-dedupe")>();
  return { ...actual, createChannelReplayGuard: vi.fn(actual.createChannelReplayGuard) };
});

class FakeBridge extends ChildProcess {
  override pid = 4242;
  readonly started = createDeferred<{ endpoint: string; token: string }>();
}

const tempWorkspaces: TempWorkspaceSync[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
type WakeEvent = { accountId: string; key: string };

type WakeInput = {
  id: string;
  timestamp: number;
  rawText: string;
  textForAgent: string;
  textForCommands: string;
};

function createContext(accountId = "default", stateDir?: string) {
  const controller = new AbortController();
  const status: ChannelAccountSnapshot = { accountId, running: false };
  const run = vi.fn(
    async (params: {
      raw: unknown;
      adapter: {
        ingest: (raw: unknown) => WakeInput;
        resolveTurn: (input: WakeInput) => Promise<{
          delivery: { deliver: () => Promise<{ visibleReplySent: false }> };
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
      enabled: true,
      profile: "openclaw",
    },
    abortSignal: controller.signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getStatus: () => status,
    setStatus: (next: ChannelAccountSnapshot) => Object.assign(status, next),
    channelRuntime: {
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "main",
          sessionKey: `agent:main:raft:${accountId}`,
        })),
      },
      inbound: { run, buildContext },
    },
  };
  return {
    ctx: ctx as unknown as ChannelGatewayContext<ResolvedRaftAccount>,
    controller,
    run,
    buildContext,
    wakeDedupe: createChannelReplayGuard<WakeEvent>({
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

function startAccount({ ctx, controller }: ReturnType<typeof createContext>) {
  const start = startRaftGatewayAccount(ctx);
  const stop = async () => {
    controller.abort();
    await start;
  };
  cleanups.push(stop);
  return { start, stop };
}

async function startGateway(fixture = createContext()) {
  const bridge = new FakeBridge();
  vi.mocked(spawn).mockImplementationOnce((_command, args, options) => {
    const endpoint = args?.at(-1);
    const token = options?.env?.RAFT_CHANNEL_TOKEN;
    if (!endpoint || !token) {
      throw new Error("Raft bridge spawn omitted its endpoint or token");
    }
    bridge.started.resolve({ endpoint, token });
    return bridge;
  });
  vi.mocked(createChannelReplayGuard<WakeEvent>).mockReturnValueOnce(fixture.wakeDedupe);
  const lifecycle = startAccount(fixture);
  const { start } = lifecycle;
  void start.catch(bridge.started.reject);
  const { endpoint, token } = await withTimeout(bridge.started.promise, 500, "Raft bridge startup");
  return {
    ...fixture,
    ...lifecycle,
    bridge,
    endpoint,
    token,
    post: (body?: unknown, authToken = token) =>
      fetch(endpoint, {
        method: "POST",
        headers: { "x-raft-bridge-token": authToken },
        body: JSON.stringify(body),
      }),
  };
}

async function expectStatus(response: Promise<Response>, status: number) {
  const result = await response;
  expect(result.status).toBe(status);
  return result;
}

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  } finally {
    processRuntimeMocks.killProcessTree.mockReset();
    vi.mocked(spawn).mockReset();
    vi.mocked(createChannelReplayGuard).mockClear();
    resetPluginStateStoreForTests();
    for (const workspace of tempWorkspaces.splice(0)) {
      workspace.cleanup();
    }
    vi.restoreAllMocks();
  }
});

it.each(["claim", "commit"] as const)(
  "joins an admitted wake during shutdown while %s is pending",
  async (phase) => {
    const fixture = createContext();
    const { controller, run, wakeDedupe } = fixture;
    const pending = createDeferred<void>();
    const reached = createDeferred<void>();
    // Release the barrier before account cleanup joins its blocked task.
    cleanups.push(() => pending.resolve());
    const pause = async () => {
      reached.resolve();
      await pending.promise;
    };
    let processing: Promise<unknown> | undefined;
    const processGuarded = wakeDedupe.processGuarded.bind(wakeDedupe);
    wakeDedupe.processGuarded = (event, process, options) => {
      const operation = processGuarded(
        event,
        async () => {
          if (phase === "claim") {
            await pause();
          }
          const result = await process();
          if (phase === "commit") {
            await pause();
          }
          return result;
        },
        options,
      );
      processing = operation;
      return operation;
    };
    const { post, start } = await startGateway(fixture);
    cleanups.push(async () => {
      await processing?.catch(() => undefined);
    });
    const stopped = vi.fn();
    const settled = start.finally(stopped);
    const request = post({ eventId: "wake-settlement" }).catch(() => undefined);
    await reached.promise;
    controller.abort();
    await request;
    await setImmediate();
    expect(stopped).not.toHaveBeenCalled();
    pending.resolve();
    await settled;
    expect(run).toHaveBeenCalledTimes(phase === "commit" ? 1 : 0);
  },
);

it("keeps a disabled account quiescent until shutdown", async () => {
  const fixture = createContext();
  fixture.ctx.account.enabled = false;
  const settled = vi.fn();
  const { start } = startAccount(fixture);
  void start.then(settled);
  await setTimeout(0);
  expect(settled).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it("keeps delivering 413 for an over-limit wake payload and closing the connection", async () => {
  const { endpoint, token, run } = await startGateway();
  // Declared and sent in one write: the shape whose rejection used to race the flush.
  const result = await postRawWebhook({
    url: endpoint,
    body: JSON.stringify({ deliveryId: "x".repeat(16 * 1024) }),
    headers: {
      "content-type": "application/json",
      "x-raft-bridge-token": token,
    },
  });

  expect(result).toMatchObject({
    statusLine: "HTTP/1.1 413 Payload Too Large",
    closedByServer: true,
  });
  expect(JSON.parse(result.body)).toEqual({
    error: "Wake payload exceeds the 16 KiB limit.",
  });
  expect(run).not.toHaveBeenCalled();
});

it("accepts authenticated content-free wake hints and dedupes retry delivery ids", async () => {
  const fixture = createContext();
  const { ctx, run, buildContext } = fixture;
  ctx.account.profile = "main'; touch /tmp/pwn; echo '";
  const { endpoint, token, post, bridge, stop } = await startGateway(fixture);
  expect(ctx.getStatus()).toMatchObject({
    running: true,
    connected: true,
    lifecycle: "ready",
    lastConnectedAt: expect.any(Number),
    lastError: null,
    terminalDisconnect: undefined,
  });
  await expectStatus(fetch(endpoint.replace("/wake", "/health")), 200);
  await expectStatus(fetch(endpoint, { method: "POST" }), 401);
  await expectStatus(post(undefined, "x".repeat(token.length)), 401);
  await expectStatus(post(undefined, "short"), 401);
  await expectStatus(post(), 400);
  await expectStatus(post({ eventId: "wake-content", metadata: { text: "not a wake hint" } }), 400);
  const accepted = await expectStatus(post({ eventId: "wake-1", timestamp: 1 }), 202);
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
  await expectStatus(fetch(drainUrl), 401);
  const drain = await expectStatus(
    fetch(drainUrl, { headers: { "x-raft-bridge-token": token } }),
    200,
  );
  await expect(drain.json()).resolves.toEqual({
    dropped: 0,
    events: [],
    schema: "raft-activity-drain.v1",
  });
  await expectStatus(post({ eventId: "wake-1", timestamp: 2 }), 202);
  expect(run).toHaveBeenCalledTimes(1);
  await expectStatus(post({ metadata: { sequence: 1, source: "bridge" } }), 400);
  expect(run).toHaveBeenCalledTimes(1);

  const input = run.mock.calls[0]?.[0].adapter.ingest({ kind: "wake" });
  expect(input?.textForAgent).toContain(
    `raft --profile 'main'"'"'; touch /tmp/pwn; echo '"'"'' message check`,
  );
  expect(input?.rawText).not.toContain("wake-1");
  await stop();
  expect(processRuntimeMocks.killProcessTree).toHaveBeenCalledOnce();
  expect(processRuntimeMocks.killProcessTree).toHaveBeenCalledWith(bridge.pid, {
    graceMs: 5_000,
    detached: process.platform !== "win32",
  });
});

it("keeps a failed delivery eligible for a bridge retry", async () => {
  const { post, run } = await startGateway();
  run.mockRejectedValueOnce(new Error("inbound runtime unavailable"));
  await expectStatus(post({ eventId: "wake-retry" }), 500);
  await expectStatus(post({ eventId: "wake-retry" }), 202);
  expect(run).toHaveBeenCalledTimes(2);
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
    const { post, run, stop } = await startGateway(createContext(accountId, workspace.dir));
    await expectStatus(post({ eventId: "wake-persisted" }), 202);
    expect(run).toHaveBeenCalledTimes(expectedCalls);
    await stop();
  }
});
