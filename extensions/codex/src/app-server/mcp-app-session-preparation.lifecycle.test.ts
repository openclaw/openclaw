import path from "node:path";
import type { AgentHarnessSessionPreparationV1 } from "openclaw/plugin-sdk/codex-mcp-projection";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  createLeasedCodexLifecycleHarness,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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
    respond: async (method) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
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
    },
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
  if (!startOptions) {
    throw new Error("The leased lifecycle fixture must supply native start options");
  }
  vi.spyOn(bindingConnection, "resolveCodexBindingAppServerConnection").mockResolvedValue({
    appServer: { ...createAppServerOptions(), start: startOptions },
    usesSupervisionConnection: false,
    requestAuthProfileId: undefined,
    clientAuthProfileId: null,
  });
  const bindingStore = createCodexTestBindingStore();
  const requests: Array<Promise<Awaited<ReturnType<typeof acquireCodexMcpAppRuntime>>>> = [];
  const request = (
    policy: {
      requesterId?: string;
      toolOverrides?: Parameters<typeof acquireCodexMcpAppRuntime>[0]["toolOverrides"];
    } = {},
  ) => {
    const abort = new AbortController();
    let callerCurrent = true;
    let hostCurrent = true;
    const assertCurrent = () => {
      if (!callerCurrent) {
        throw new Error("caller selection revoked");
      }
    };
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
        abortSignal: abort.signal,
        authProfileStore: { version: 1, profiles: {} },
        hostCapabilities: createCodexTestHostCapabilities({
          assertActive: () => {
            if (!hostCurrent) {
              throw new Error("host source revoked");
            }
          },
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
    requests.push(pending);
    // Observe rejection immediately; assertions below still inspect the original promise.
    void pending.catch(() => undefined);
    return {
      pending,
      prepareSession,
      revoke: (scope: "caller" | "host" | "abort") => {
        if (scope === "caller") {
          callerCurrent = false;
        } else if (scope === "host") {
          hostCurrent = false;
        } else {
          abort.abort(new Error("request aborted"));
        }
      },
    };
  };
  const waitForQueuedRequests = (count: number) => {
    const queued = createDeferred<void>();
    const withLease = bindingStore.withLease.bind(bindingStore);
    let observed = 0;
    vi.spyOn(bindingStore, "withLease").mockImplementation((identity, operation) => {
      if (++observed === count) {
        queued.resolve();
      }
      return withLease(identity, operation);
    });
    return queued.promise;
  };
  return {
    wire,
    request,
    entered: entered.promise,
    proceed,
    acquireClient,
    bindingStore,
    identity: sessionBindingIdentity(session),
    waitForQueuedRequests,
    cleanup: async () => {
      proceed.resolve();
      await vi.advanceTimersByTimeAsync(3_000);
      for (const result of await Promise.allSettled(requests)) {
        if (result.status === "fulfilled" && result.value) {
          result.value.releaseLease();
          await result.value.runtime.joinCleanup?.();
        }
      }
    },
  };
}

describe("native MCP App acquisition through the real cold lifecycle", () => {
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
  const catalog = (
    lease: Awaited<ReturnType<typeof acquireCodexMcpAppRuntime>>,
    tools: unknown[],
  ) => {
    expect(lease).toBeDefined();
    return expect(lease!.runtime.getCatalog()).resolves.toMatchObject({ tools });
  };
  const visibleTools = [{ serverName: "demo", toolName: "show" }];
  it("shares one native thread across concurrent cold discoveries", async () => {
    const first = f.request();
    await f.entered;
    const queued = f.waitForQueuedRequests(2);
    const second = f.request();
    const third = f.request();
    await queued;
    f.proceed.resolve();
    const firstLease = await first.pending;
    await vi.advanceTimersByTimeAsync(2_000);
    const leases = [firstLease, ...(await Promise.all([second.pending, third.pending]))];
    for (const lease of leases) {
      await catalog(lease, visibleTools);
    }
    expectSingleOwner();
    expect(f.bindingStore.read(f.identity)).toMatchObject({ threadId: "app-thread" });
    expectLiveOwner();
    expect(methods()).not.toContain("turn/start");
  });

  it("keeps queued and warm borrows on the session owner with their own requester and tool limits", async () => {
    const first = f.request({ requesterId: "alice" });
    await f.entered;
    const queued = f.waitForQueuedRequests(1);
    const restricted = {
      requesterId: "bob",
      toolOverrides: { mcpToolsDeny: { demo: ["show"] } },
    };
    const second = f.request(restricted);
    await queued;
    f.proceed.resolve();
    const firstLease = await first.pending;
    await vi.advanceTimersByTimeAsync(1_000);
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
    expect(methods()).not.toContain("thread/resume");
  });

  it.each(["caller", "host", "abort"] as const)(
    "rejects a queued %s revocation without releasing the winning owner",
    async (scope) => {
      const first = f.request();
      await f.entered;
      const queued = f.waitForQueuedRequests(1);
      const second = f.request();
      await queued;
      second.revoke(scope);
      f.proceed.resolve();
      await expect(first.pending).resolves.toBeDefined();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(second.pending).rejects.toThrow(scope === "abort" ? "aborted" : "revoked");
      expectLiveOwner();
      expect(f.acquireClient).toHaveBeenCalledOnce();
    },
  );

  it("propagates native startup failure without a replacement runtime", async () => {
    const first = f.request();
    await f.entered;
    f.proceed.reject(new Error("native startup denied"));
    await expect(first.pending).rejects.toThrow("native startup denied");
    expect(f.bindingStore.read(f.identity)).toBeUndefined();
    expectSingleOwner();
  });
});
