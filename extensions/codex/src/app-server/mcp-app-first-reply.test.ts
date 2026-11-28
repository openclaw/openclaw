import path from "node:path";
import type { AgentHarnessSessionPreparationV1 } from "openclaw/plugin-sdk/codex-mcp-projection";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";
import {
  createAppServerOptions,
  createLifecycleRequest,
  createLeasedCodexLifecycleHarness,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks({ isolateNativeSkillHome: true });

it.each([
  "retained",
  "released",
  "publishing",
  "publishing-cancelled",
  "publishing-other-client-released",
  "publishing-other-client-protected",
])("admits the first reply (discovery=%s)", async (discovery) => {
  const retainLease = !discovery.endsWith("released");
  const publishing = discovery.startsWith("publishing");
  const cancelled = discovery === "publishing-cancelled";
  const otherClient = discovery.startsWith("publishing-other-client");
  const protectedOtherClient = discovery === "publishing-other-client-protected";
  const starting = createDeferred<void>();
  const publish = createDeferred<void>();
  const replyQueued = createDeferred<void>();
  const params = createTestParams();
  params.agentId = "main";
  params.permissionMode = "full";
  let nextThread = 0;
  params.agentDir = path.join(params.workspaceDir, "agent");
  await attachSqliteSessionTarget(
    params,
    path.join(params.workspaceDir, "sessions.sqlite"),
    params.sessionId,
  );
  registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
  let replyWire: Awaited<ReturnType<typeof createLeasedCodexLifecycleHarness>> | undefined;
  const respond = createLifecycleRequest(async (method, requestParams) => {
    if (method === "thread/start") {
      const first = ++nextThread === 1;
      if (first && publishing) {
        starting.resolve();
        await publish.promise;
      }
      return threadStartResult(first ? "app-thread" : "reply-thread");
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
        (replyWire ?? wire).notify({
          method: "turn/completed",
          params: {
            threadId: (requestParams as { threadId: string }).threadId,
            turn: {
              id: "turn-1",
              status: "completed",
              items: [
                {
                  type: "agentMessage",
                  id: "answer",
                  phase: "final_answer",
                  text: "First reply accepted.",
                },
              ],
            },
          },
        }),
      );
      return { turn: { id: "turn-1", status: "inProgress", items: [] } };
    }
    return {};
  });
  const wire = await createLeasedCodexLifecycleHarness({
    agentDir: params.agentDir,
    codexHome: path.join(params.agentDir, "codex-home"),
    respond,
  });
  if (otherClient) {
    replyWire = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(params.agentDir, "reply-client"),
      codexHome: path.join(params.agentDir, "codex-home"),
      respond,
    });
    expect(replyWire.client.getInstanceId()).not.toBe(wire.client.getInstanceId());
  }
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
  const acquiring = acquireCodexMcpAppRuntime(
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
  let reply: ReturnType<typeof runCodexAppServerAttempt> | undefined;
  if (publishing) {
    await starting.promise;
    const withLease = testCodexAppServerBindingStore.withLease.bind(testCodexAppServerBindingStore);
    const queued = vi
      .spyOn(testCodexAppServerBindingStore, "withLease")
      .mockImplementation((...args) => {
        replyQueued.resolve();
        return withLease(...args);
      });
    const controller = new AbortController();
    params.abortSignal = controller.signal;
    reply = runCodexAppServerAttempt(params, {
      pluginConfig,
      clientFactory: async () => acquire(replyWire?.acquireOptions ?? wire.acquireOptions),
    });
    // Observe rejection immediately while publication still owns the binding lease.
    void reply.catch(() => {});
    await replyQueued.promise;
    queued.mockRestore();
    if (cancelled) {
      controller.abort(new Error("first reply cancelled"));
    }
    publish.resolve();
  }
  const lease = await acquiring;
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
    const attempt =
      reply ??
      runCodexAppServerAttempt(params, {
        pluginConfig,
        clientFactory: async () => acquire(replyWire?.acquireOptions ?? wire.acquireOptions),
      });
    if (cancelled) {
      await expect(attempt).rejects.toMatchObject({ code: "CODEX_APP_SERVER_STARTUP_CANCELLED" });
    } else if (protectedOtherClient) {
      await expect(attempt).rejects.toThrow(
        "Codex thread app-thread is claimed by active work; stop it first.",
      );
    } else {
      await expect(attempt).resolves.toMatchObject({ terminal: { kind: "ok" } });
    }
    expect((replyWire ?? wire).request.mock.calls.some(([method]) => method === "turn/start")).toBe(
      !cancelled && !protectedOtherClient,
    );
    const messages = await readTranscriptMessagesByIdentity(params);
    expect(
      messages.filter((message) => message.role === "assistant").map((message) => message.content),
    ).toEqual(
      cancelled || protectedOtherClient ? [] : [[{ type: "text", text: "First reply accepted." }]],
    );
  } finally {
    if (retainLease) {
      lease!.releaseLease();
      await lease!.runtime.joinCleanup?.();
    }
  }
});
