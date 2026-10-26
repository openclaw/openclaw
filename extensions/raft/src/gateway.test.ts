import { ChildProcess } from "node:child_process";
import { setImmediate, setTimeout } from "node:timers/promises";
import type { ChannelInboundEventRunnerParams } from "openclaw/plugin-sdk/channel-inbound";
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
import { postRawWebhook } from "openclaw/plugin-sdk/test-env";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { startRaftGatewayAccount } from "./gateway.js";

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>()),
  killProcessTree: vi.fn(),
  spawnOomScoreAdjusted: vi.fn(),
}));

const tempWorkspaces: TempWorkspaceSync[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
type WakeEvent = { accountId: string; key: string };
type WakeInput = Parameters<ChannelInboundEventRunnerParams<unknown>["adapter"]["resolveTurn"]>[0];
type WakeDispatch = {
  raw: unknown;
  adapter: {
    ingest: (raw: unknown) => WakeInput;
    resolveTurn: (input: WakeInput) => Promise<{
      delivery: { deliver: () => Promise<{ visibleReplySent: false }> };
    }>;
  };
};

function createContext(accountId = "default", stateDir?: string) {
  const controller = new AbortController();
  const run = vi.fn(async ({ raw, adapter }: WakeDispatch) => {
    const turn = await adapter.resolveTurn(adapter.ingest(raw));
    await turn.delivery.deliver();
  });
  const buildContext = vi.fn(() => ({}));
  const ctx = createStartAccountContext({
    account: { accountId, enabled: true, profile: "openclaw", configured: true, name: undefined },
    abortSignal: controller.signal,
  });
  const route = { agentId: "main", sessionKey: `agent:main:raft:${accountId}` };
  Object.assign(ctx, {
    channelRuntime: {
      routing: { resolveAgentRoute: () => route },
      inbound: { run, buildContext },
    },
  });
  return {
    ctx,
    controller,
    run,
    buildContext,
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
  const bridge = Object.assign(new ChildProcess(), { pid: 4242 });
  const started = createDeferred<{ endpoint: string; token: string }>();
  vi.mocked(spawn).mockImplementationOnce((_command, args, options) => {
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
  const lifecycle = startAccount(fixture);
  void lifecycle.start.catch(started.reject);
  const { endpoint, token } = await withTimeout(started.promise, 500, "Raft bridge startup");
  const request = async (path: string, status: number, init: RequestInit): Promise<unknown> => {
    const response = await fetch(new URL(path, endpoint), init);
    expect(response.status).toBe(status);
    return response.json();
  };
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
  try {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  } finally {
    vi.mocked(killProcessTree).mockReset();
    vi.mocked(spawn).mockReset();
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
    for (const workspace of tempWorkspaces.splice(0)) {
      workspace.cleanup();
    }
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
    const pause = async <T>(result: T) => {
      reached.resolve();
      await pending.promise;
      return result;
    };
    const processGuarded = wakeDedupe.processGuarded.bind(wakeDedupe);
    wakeDedupe.processGuarded = (event, process, options) =>
      processGuarded(
        event,
        phase === "claim" ? () => pause(undefined).then(process) : () => process().then(pause),
        options,
      );
    const { post, start } = await startGateway(fixture);
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
  expect(run).not.toHaveBeenCalled();
});

it("accepts authenticated content-free wake hints and dedupes retry delivery ids", async () => {
  const fixture = createContext();
  const { ctx, run, buildContext } = fixture;
  ctx.account.profile = "main'; touch /tmp/pwn; echo '";
  const { token, get, post, bridge, stop } = await startGateway(fixture);
  expect(ctx.getStatus()).toMatchObject({ running: true, connected: true, lifecycle: "ready" });
  await get("/health");
  await post(undefined, 401, null);
  await post(undefined, 401, "x".repeat(token.length));
  await post(undefined, 401, "short");
  await post(undefined, 400);
  await post({ eventId: "wake-content", metadata: { text: "not a wake hint" } }, 400);
  const accepted = await post({ eventId: "wake-1", timestamp: 1 });
  expect(accepted).toMatchObject({ accepted: true, ok: true, runtimeSession: expect.any(String) });
  expect(run).toHaveBeenCalledTimes(1);
  expect(buildContext).toHaveBeenCalledWith(
    expect.objectContaining({ channelIngress: "unsupported" }),
  );

  await get("/activity/drain?max=50", 401, "");
  const drain = await get("/activity/drain?max=50");
  expect(drain).toEqual({ dropped: 0, events: [], schema: "raft-activity-drain.v1" });
  await post({ metadata: { sequence: 1, source: "bridge" } }, 400);
  await post({ eventId: "wake-1", timestamp: 2 });
  expect(run).toHaveBeenCalledTimes(1);

  const input = run.mock.calls[0]?.[0].adapter.ingest({ kind: "wake" });
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
});

it("keeps a failed delivery eligible for a bridge retry", async () => {
  const { post, run } = await startGateway();
  run.mockRejectedValueOnce(new Error("inbound runtime unavailable"));
  await post({ eventId: "wake-retry" }, 500);
  await post({ eventId: "wake-retry" });
  expect(run).toHaveBeenCalledTimes(2);
});

it("persists accepted wake dedupe across restarts without crossing accounts", async () => {
  const workspace = tempWorkspaceSync({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-raft-wake-dedupe-",
  });
  tempWorkspaces.push(workspace);
  const stateDir = workspace.dir;
  for (const phase of ["first", "restart", "other"] as const) {
    const accountId = phase === "other" ? "other" : "default";
    const { post, run, stop } = await startGateway(createContext(accountId, stateDir));
    await post({ eventId: "wake-persisted" });
    expect(run).toHaveBeenCalledTimes(phase === "restart" ? 0 : 1);
    await stop();
  }
});
