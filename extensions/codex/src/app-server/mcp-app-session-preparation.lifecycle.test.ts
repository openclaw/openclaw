import path from "node:path";
import type { AgentHarnessSessionPreparationV1 } from "openclaw/plugin-sdk/codex-mcp-projection";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as bindingConnection from "./binding-connection.js";
import { hasCodexAppServerLiveThread } from "./client-runtime.js";
import { acquireCodexMcpAppRuntime } from "./effective-mcp-catalog.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { sessionBindingIdentity } from "./session-binding.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import * as sharedClient from "./shared-client.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";
import {
  createAppServerOptions,
  createLifecycleRequest,
  createLeasedCodexLifecycleHarness,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Lease = Awaited<ReturnType<typeof acquireCodexMcpAppRuntime>>;
type Params = Parameters<typeof acquireCodexMcpAppRuntime>[0];
type Policy = Pick<Params, "toolOverrides"> & { requesterId?: string };
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture() {
  const workspaceDir = tempDirs.make("openclaw-mcp-app-cold-owner-");
  const agentDir = path.join(workspaceDir, "agent");
  const sessionKey = "agent:main:cold-app";
  const config = { session: { store: path.join(workspaceDir, "sessions.json") } };
  const session = { sessionId: "cold-session", sessionKey, agentId: "main", config, workspaceDir };
  const entered = createDeferred<void>();
  const proceed = createDeferred<void>();
  const wire = await createLeasedCodexLifecycleHarness({
    agentDir,
    respond: createLifecycleRequest(async (method) => {
      if (method === "thread/start") {
        entered.resolve();
        await proceed.promise;
        return threadStartResult("app-thread");
      }
      if (method === "mcpServerStatus/list") {
        return {
          data: [{ name: "demo", tools: { show: { inputSchema: { type: "object" } } } }],
          nextCursor: null,
        };
      }
      throw new Error("unexpected method: " + method);
    }),
  });
  const acquire = sharedClient.getLeasedSharedCodexAppServerClient;
  const acquireClient = vi
    .spyOn(sharedClient, "getLeasedSharedCodexAppServerClient")
    .mockImplementation((options) =>
      acquire({
        ...wire.acquireOptions,
        abandonSignal: options?.abandonSignal,
        assertCurrent: options?.assertCurrent,
      }),
    );
  const startOptions = wire.acquireOptions.startOptions;
  expect(startOptions).toBeDefined();
  vi.spyOn(bindingConnection, "resolveCodexBindingAppServerConnection").mockResolvedValue({
    appServer: { ...createAppServerOptions(), start: startOptions! },
    usesSupervisionConnection: false,
    clientAuthProfileId: null,
  });
  const bindingStore = createCodexTestBindingStore();
  const requests: Promise<Lease>[] = [];
  const request = (policy: Policy = {}) => {
    const controllers = {
      caller: new AbortController(),
      host: new AbortController(),
      abort: new AbortController(),
    };
    const assertCurrent = () => controllers.caller.signal.throwIfAborted();
    const preparation: AgentHarnessSessionPreparationV1 = {
      version: 1,
      purpose: "mcp-app",
      params: {
        ...session,
        runId: "prepare-app",
        agentDir,
        provider: "openai",
        modelId: "gpt-5.4-codex",
        permissionMode: "full",
        senderId: policy.requesterId,
        toolOverrides: policy.toolOverrides,
        abortSignal: controllers.abort.signal,
        authProfileStore: { version: 1, profiles: {} },
        hostCapabilities: createCodexTestHostCapabilities({
          assertActive: () => controllers.host.signal.throwIfAborted(),
        }),
      },
      run: async (operation) => operation(),
    };
    const prepareSession = vi.fn(async () => preparation);
    const pending = acquireCodexMcpAppRuntime(
      {
        ...session,
        mcpServerNames: ["demo"],
        toolOverrides: policy.toolOverrides,
        appRequester: policy.requesterId
          ? { kind: "gateway-profile", profileId: policy.requesterId }
          : undefined,
        assertCurrent,
        prepareSession,
      },
      { bindingStore, pluginConfig: { codexPlugins: { enabled: false } } },
    );
    requests.push(pending.catch(() => undefined));
    const revoke = (scope: keyof typeof controllers) =>
      controllers[scope].abort(
        new Error(scope === "abort" ? "request aborted" : scope + " source revoked"),
      );
    return { pending, prepareSession, revoke };
  };
  return {
    wire,
    request,
    entered: entered.promise,
    proceed,
    acquireClient,
    bindingStore,
    identity: sessionBindingIdentity(session),
    settle: async (pendingRequest: ReturnType<typeof request>, delay = 1_000) => {
      proceed.resolve();
      const lease = await pendingRequest.pending;
      await vi.advanceTimersByTimeAsync(delay);
      return lease;
    },
    queue: async (firstPolicy: Policy = {}, secondPolicy: Policy = {}) => {
      const first = request(firstPolicy);
      await entered.promise;
      const queued = createDeferred<void>();
      const withLease = bindingStore.withLease.bind(bindingStore);
      vi.spyOn(bindingStore, "withLease").mockImplementation((identity, operation) => {
        queued.resolve();
        return withLease(identity, operation);
      });
      const second = request(secondPolicy);
      await queued.promise;
      return { first, second };
    },
    cleanup: async () => {
      proceed.resolve();
      await vi.advanceTimersByTimeAsync(3_000);
      for (const lease of await Promise.all(requests)) {
        if (lease) {
          lease.releaseLease();
          await lease.runtime.joinCleanup?.();
        }
      }
    },
  };
}

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
  vi.useFakeTimers();
});
afterEach(async () => f.cleanup());
const methods = () => f.wire.request.mock.calls.map(([method]) => method);
const expectSingleOwner = () => {
  expect(f.acquireClient).toHaveBeenCalledOnce();
  expect(methods().filter((method) => method === "thread/start")).toHaveLength(1);
};
const expectLiveOwner = () => {
  expect(hasCodexAppServerLiveThread(f.wire.client, "app-thread")).toBe(true);
  expect(methods()).not.toContain("thread/unsubscribe");
};
const catalog = (lease: Lease, tools: unknown[]) =>
  expect(lease!.runtime.getCatalog()).resolves.toMatchObject({ tools });
const visibleTools = [{ serverName: "demo", toolName: "show" }];
it("shares one cold native thread while isolating queued and warm requester limits", async () => {
  const restricted = { requesterId: "bob", toolOverrides: { mcpToolsDeny: { demo: ["show"] } } };
  const { first, second } = await f.queue({ requesterId: "alice" }, restricted);
  const firstLease = await f.settle(first);
  const secondLease = await second.pending;
  const warm = f.request(restricted);
  const warmLease = await warm.pending;
  await catalog(firstLease, visibleTools);
  for (const lease of [secondLease, warmLease]) {
    await catalog(lease, []);
    expect(lease!.runtime.configFingerprint).toBe(firstLease!.runtime.configFingerprint);
    expect(lease!.runtime.appRequester).toEqual({ kind: "gateway-profile", profileId: "bob" });
  }
  expect(second.prepareSession).toHaveBeenCalledOnce();
  expect(warm.prepareSession).not.toHaveBeenCalled();
  expectSingleOwner();
  expect(f.bindingStore.read(f.identity)).toMatchObject({ threadId: "app-thread" });
  expectLiveOwner();
  expect(methods()).not.toContain("turn/start");
  expect(methods()).not.toContain("thread/resume");
});

it.each(["caller", "host", "abort"] as const)("rejects queued %s revocation", async (scope) => {
  const { first, second } = await f.queue();
  second.revoke(scope);
  expect(await f.settle(first)).toBeDefined();
  await expect(second.pending).rejects.toThrow(scope === "abort" ? "aborted" : "revoked");
  expectLiveOwner();
  expect(f.acquireClient).toHaveBeenCalledOnce();
});

it("propagates native startup failure without a replacement runtime", async () => {
  const first = f.request();
  await f.entered;
  f.proceed.reject(new Error("native startup denied"));
  await expect(first.pending).rejects.toThrow("native startup denied");
  expect(f.bindingStore.read(f.identity)).toBeUndefined();
  expectSingleOwner();
});
