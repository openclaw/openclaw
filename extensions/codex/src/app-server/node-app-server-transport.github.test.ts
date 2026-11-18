import {
  prepareWorkerGitHubBindingGrant,
  type WorkerGitHubBindingGrant,
  type WorkerGitHubBindingRefresh,
} from "openclaw/plugin-sdk/github-worker-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { useCodexWorkerProvisioningFixture } from "../node-app-server-command.test-support.js";
import type { CodexAppServerClient } from "./client.js";
import { createCodexWorkerClientFactory } from "./node-app-server-transport.js";

vi.mock("openclaw/plugin-sdk/github-worker-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/github-worker-runtime")>()),
  prepareWorkerGitHubBindingGrant: vi.fn(),
}));

const provisionWorker = useCodexWorkerProvisioningFixture();
const update: WorkerGitHubBindingRefresh = {
  generation: 1,
  token: "synthetic-worker-2",
  expiresAtMs: Date.parse("2026-11-18T01:00:00Z"),
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function credentialTransport() {
  provisionWorker();
  vi.useFakeTimers();
  // The SDK grant is an external contract fixture, not an issuer/expiry model.
  // The production Codex adapter, client and duplex framing remain real.
  const refreshed = Promise.withResolvers<WorkerGitHubBindingRefresh | undefined>();
  const refreshing = Promise.withResolvers<void>();
  const revoked = Promise.withResolvers<void>();
  let holdRevocation = false;
  const grant = {
    binding: { token: "synthetic-worker-1", host: "github.com", login: "worker-bot" },
    signal: new AbortController().signal,
    assertCurrent() {},
    refresh: vi
      .fn<WorkerGitHubBindingGrant["refresh"]>()
      .mockResolvedValueOnce(update)
      .mockResolvedValue(undefined),
    revoke: vi.fn(async () => {
      if (holdRevocation) {
        await revoked.promise;
      }
    }),
  } satisfies WorkerGitHubBindingGrant;
  vi.mocked(prepareWorkerGitHubBindingGrant).mockReset().mockResolvedValue(grant);
  const physicalClose = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  type Request = { id: number; method: string; params?: unknown };
  const initial = Promise.withResolvers<Request>();
  const renewal = Promise.withResolvers<Request>();
  const sent: Request[] = [];
  let receive: ((frame: Uint8Array) => void | Promise<void>) | undefined;
  let installations = 0;
  const reply = async (request: Request, result: unknown) => {
    await receive?.(Buffer.from(JSON.stringify({ id: request.id, result })));
  };
  const runtime: Pick<PluginRuntime, "nodes"> = {
    nodes: {
      list: async () => {
        throw new Error("Unexpected discovery");
      },
      invoke: async () => {
        throw new Error("Unexpected unary invocation");
      },
      openDuplex: vi.fn<PluginRuntime["nodes"]["openDuplex"]>(async () => ({
        async send(frame) {
          const request = JSON.parse(Buffer.from(frame).toString("utf8")) as Request;
          sent.push(request);
          if (request.method === "openclaw/github/refresh") {
            (installations++ === 0 ? initial : renewal).resolve(request);
          } else if (request.id !== undefined) {
            await reply(
              request,
              request.method === "initialize" ? { userAgent: "codex-cli/0.164.0" } : { ok: true },
            );
          }
        },
        onMessage(listener) {
          receive = listener;
          return () => {
            receive = undefined;
          };
        },
        close: () => closing.resolve(),
        closed: physicalClose.promise,
      })),
    },
  };
  let client: CodexAppServerClient | undefined;
  const sandbox = {
    ...createSandboxTestContext(),
    sessionKey: "agent:main:worker",
    placementExecutionMode: "remote-exec",
    placementNodeId: "node",
    placementEnvironmentId: "environment",
    placementSessionId: "session",
    placementOwnerEpoch: 1,
  };
  const factory = createCodexWorkerClientFactory({
    runtime,
    agentId: "main",
    permissionMode: "full",
    sandbox,
    signal: new AbortController().signal,
    assertCurrent() {},
  });
  onTestFinished(async () => {
    refreshed.resolve(update);
    revoked.resolve();
    physicalClose.resolve();
    await client?.closeAndWait();
  });
  return {
    start: () => factory({ onStartedClient: (value) => (client = value) }),
    runtime,
    grant,
    sent,
    reply,
    initial: initial.promise,
    renewal: renewal.promise,
    closing: closing.promise,
    disconnect: () => physicalClose.resolve(),
    refreshed,
    revoked,
    refreshing: refreshing.promise,
    holdRenewal() {
      holdRevocation = true;
      grant.refresh.mockReset().mockImplementationOnce(() => {
        refreshing.resolve();
        return refreshed.promise;
      });
    },
  };
}

it.each([
  { stage: "renewal", acknowledgment: "exact", response: { generation: 1 } },
  { stage: "initial", acknowledgment: "mismatched", response: { generation: 1 } },
  { stage: "initial", acknowledgment: "missing", response: {} },
  { stage: "initial", acknowledgment: "timeout", response: undefined },
  { stage: "renewal", acknowledgment: "mismatched", response: { generation: 0 } },
  { stage: "renewal", acknowledgment: "missing", response: {} },
  { stage: "renewal", acknowledgment: "timeout", response: undefined },
])(
  "worker GitHub $stage installation: $acknowledgment generation acknowledgment",
  async ({ stage, acknowledgment, response }) => {
    const h = credentialTransport();
    let ready = false;
    const starting = h.start().then((client) => {
      ready = true;
      return client;
    });
    void starting.catch(() => {});
    const first = await Promise.race([
      h.initial,
      starting.then(() => {
        throw new Error("Worker became ready without installation acknowledgment");
      }),
    ]);
    expect(ready).toBe(false);
    expect(prepareWorkerGitHubBindingGrant).toHaveBeenCalledExactlyOnceWith({
      agentId: "main",
      sessionId: "session",
      sessionKey: "agent:main:worker",
      signal: expect.any(AbortSignal),
      assertCurrent: expect.any(Function),
    });
    expect(first.params).toEqual({ generation: 0, token: "synthetic-worker-1" });
    expect(h.runtime.nodes.openDuplex).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node",
        sessionKey: "agent:main:worker",
        params: expect.objectContaining({
          github: h.grant.binding,
          authorization: "session-full",
          placement: expect.objectContaining({
            environmentId: "environment",
            sessionId: "session",
            sessionKey: "agent:main:worker",
            ownerEpoch: 1,
          }),
        }),
      }),
    );
    expect(h.grant.refresh).not.toHaveBeenCalled();
    let request = first;
    let client: CodexAppServerClient | undefined;
    if (stage === "renewal") {
      await h.reply(first, { generation: 0 });
      client = await starting;
      await vi.advanceTimersByTimeAsync(30_000);
      request = await h.renewal;
      expect(request.params).toEqual(update);
      expect(h.grant.refresh.mock.calls).toEqual([[0]]);
    }
    expect(h.grant.revoke).not.toHaveBeenCalled();
    if (acknowledgment === "timeout") {
      await vi.advanceTimersByTimeAsync(15_000);
    } else {
      await h.reply(request, response);
    }
    await vi.advanceTimersByTimeAsync(0);
    if (acknowledgment === "exact") {
      expect(h.grant.refresh.mock.calls).toEqual([[0], [1]]);
      expect(await client?.request("turn/start", { threadId: "thread" })).toEqual({ ok: true });
      expect(h.grant.revoke).not.toHaveBeenCalled();
    } else if (client) {
      await expect(client.request("turn/start", { threadId: "thread" })).rejects.toThrow();
      expect(h.sent.some((value) => value.method === "turn/start")).toBe(false);
      expect(h.grant.refresh.mock.calls).toEqual([[0]]);
    }
    h.disconnect();
    if (client) {
      await client.closeAndWait();
    } else {
      await expect(starting).rejects.toThrow(
        acknowledgment === "timeout" ? /timed out/ : /installer is unavailable/,
      );
      expect(h.grant.refresh).not.toHaveBeenCalled();
    }
    expect(h.grant.revoke).toHaveBeenCalledOnce();
  },
);

it.each(["disconnect", "caller close"])(
  "joins pending SDK refresh and revocation after %s",
  async (mode) => {
    const h = credentialTransport();
    const starting = h.start();
    await h.reply(await h.initial, { generation: 0 });
    const client = await starting;
    h.holdRenewal();
    await vi.advanceTimersByTimeAsync(30_000);
    await h.refreshing;
    if (mode === "disconnect") {
      h.disconnect();
      await h.closing;
    }
    let settled = false;
    const cleanup = client.closeAndWait().then(() => {
      settled = true;
    });
    await h.closing;
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    h.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.grant.revoke).toHaveBeenCalledOnce();
    // Neither completion alone discharges adapter cleanup, in either order.
    if (mode === "disconnect") {
      h.revoked.resolve();
    } else {
      h.refreshed.resolve(update);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    h.revoked.resolve();
    h.refreshed.resolve(update);
    await cleanup;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.grant.refresh.mock.calls).toEqual([[0]]);
    expect(h.grant.revoke).toHaveBeenCalledOnce();
    expect(h.sent.filter((request) => request.method === "openclaw/github/refresh")).toHaveLength(
      1,
    );
    await expect(client.request("turn/start", { threadId: "thread" })).rejects.toThrow();
    expect(h.sent.some((request) => request.method === "turn/start")).toBe(false);
  },
);
