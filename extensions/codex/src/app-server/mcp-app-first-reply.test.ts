import path from "node:path";
import type { AgentHarnessSessionPreparationV1 } from "openclaw/plugin-sdk/codex-mcp-projection";
import { expect, it, vi } from "vitest";
import * as bindingConnection from "./binding-connection.js";
import {
  isCodexAppServerLiveThreadClaimed,
  isCodexAppServerLiveThreadProtected,
} from "./client-runtime.js";
import { acquireCodexMcpAppRuntime } from "./effective-mcp-catalog.js";
import {
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";
import { sessionBindingIdentity } from "./session-binding.js";
import {
  registerCodexTestSessionIdentity,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import * as sharedClient from "./shared-client.js";
import {
  createAppServerOptions,
  createLifecycleRequest,
  createLeasedCodexLifecycleHarness,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks({ isolateNativeSkillHome: true });

it.each([true, false])(
  "admits the first reply (discovery lease retained=%s)",
  async (retainLease) => {
    const params = createTestParams();
    params.agentId = "main";
    params.permissionMode = "full";
    let nextThread = 0;
    params.agentDir = path.join(params.workspaceDir, "agent");
    registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
    const wire = await createLeasedCodexLifecycleHarness({
      agentDir: params.agentDir,
      codexHome: path.join(params.agentDir, "codex-home"),
      respond: createLifecycleRequest(async (method, requestParams) => {
        if (method === "thread/start") {
          return threadStartResult(++nextThread === 1 ? "app-thread" : "reply-thread");
        }
        if (method === "thread/resume") {
          return threadStartResult((requestParams as { threadId: string }).threadId);
        }
        if (method === "skills/list") {
          return { data: [] };
        }
        if (method === "mcpServerStatus/list") {
          return { data: [], nextCursor: null };
        }
        if (method === "turn/start") {
          queueMicrotask(() =>
            wire.notify({
              method: "turn/completed",
              params: {
                threadId: (requestParams as { threadId: string }).threadId,
                turn: { id: "turn-1", status: "completed", items: [] },
              },
            }),
          );
          return { turn: { id: "turn-1", status: "inProgress", items: [] } };
        }
        return {};
      }),
    });
    const acquire = sharedClient.getLeasedSharedCodexAppServerClient;
    vi.spyOn(sharedClient, "getLeasedSharedCodexAppServerClient").mockImplementation((options) =>
      acquire({
        ...wire.acquireOptions,
        abandonSignal: options?.abandonSignal,
        assertCurrent: options?.assertCurrent,
      }),
    );
    vi.spyOn(bindingConnection, "resolveCodexBindingAppServerConnection").mockResolvedValue({
      appServer: { ...createAppServerOptions(), start: wire.acquireOptions.startOptions! },
      usesSupervisionConnection: false,
      clientAuthProfileId: null,
    });
    const preparation: AgentHarnessSessionPreparationV1 = {
      version: 1,
      purpose: "mcp-app",
      params: { ...params, permissionMode: "full" },
      run: async (operation) => operation(),
    };
    const pluginConfig = { codexPlugins: { enabled: false } };
    const lease = await acquireCodexMcpAppRuntime(
      {
        agentId: params.agentId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey!,
        workspaceDir: params.workspaceDir,
        config: params.config!,
        mcpServerNames: ["demo"],
        assertCurrent: () => params.hostCapabilities.assertActive(),
        prepareSession: async () => preparation,
      },
      { bindingStore: testCodexAppServerBindingStore, pluginConfig },
    );
    expect(lease).toBeDefined();
    const preliminary = testCodexAppServerBindingStore.read(sessionBindingIdentity(params));
    expect(preliminary?.restrictedThreadConfigFingerprint).toBeTruthy();
    expect(preliminary?.nativeToolPolicyRestricted).toBeUndefined();
    expect(isCodexAppServerLiveThreadClaimed(wire.client, "app-thread")).toBe(false);
    expect(isCodexAppServerLiveThreadProtected(wire.client, "app-thread")).toBe(true);
    if (!retainLease) {
      lease!.releaseLease();
      await lease!.runtime.joinCleanup?.();
    }
    try {
      const outcome = await runCodexAppServerAttempt(params, {
        pluginConfig,
        clientFactory: async () => acquire(wire.acquireOptions),
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      expect(outcome).not.toHaveProperty("error");
      expect(wire.request.mock.calls.some(([method]) => method === "turn/start")).toBe(true);
    } finally {
      if (retainLease) {
        lease!.releaseLease();
        await lease!.runtime.joinCleanup?.();
      }
    }
  },
);
