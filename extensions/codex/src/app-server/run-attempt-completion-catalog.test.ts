import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import { isCodexAppServerLiveThreadProtected } from "./client-runtime.js";
import { createDynamicToolCall, createTool } from "./dynamic-tools.test-support.js";
import {
  createCodexTestHostCapabilities,
  setCodexTestToolFactory,
} from "./host-capability.test-support.js";
import { ownCodexInferenceClient } from "./inference-routing.js";
import { nativeHookRelayUnregisterQueue } from "./native-hook-relay-state.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import {
  agentMessage,
  childTurnCompletedNotification,
  createClient,
  createRuntime,
  directSpawnItem,
  threadRead,
  turnStartedNotification,
} from "./native-subagent-monitor.test-support.js";
import { isJsonObject } from "./protocol.js";
import { retainSourceAuthority } from "./run-attempt-continuity.test-support.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { writeNativeCatalogFixture } from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks();

it("retains the last terminal child's parent catalog through detached delivery without retaining executors", async () => {
  const agentDir = path.join(tempDir, "wire-agent");
  const codexHome = resolveCodexAppServerHomeDir(agentDir);
  const rolloutPath = path.join(codexHome, "sessions", "completion-parent.jsonl");
  const sessionFile = path.join(tempDir, "completion-parent.jsonl");
  const entered = createDeferred<void>();
  const releaseDelivery = createDeferred<void>();
  const runtime = createRuntime();
  runtime.deliverAgentHarnessCompletion.mockImplementation(async () => {
    entered.resolve();
    await releaseDelivery.promise;
    return { delivered: true, path: "direct" };
  });
  const register = codexNativeSubagentMonitorRuntime.register;
  vi.spyOn(codexNativeSubagentMonitorRuntime, "register").mockImplementation((request) =>
    register({ ...request, runtime }),
  );
  const harness = createStartedThreadHarness(
    async (method, request) => {
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "thread/start" && isJsonObject(request)) {
        await writeNativeCatalogFixture(rolloutPath, "thread-1", request.dynamicTools);
        const result = threadStartResult("thread-1");
        return { ...result, thread: { ...result.thread, path: rolloutPath } };
      }
      if (method === "thread/read") {
        return threadRead({
          childThreadId: "child-thread",
          parentThreadId: "thread-1",
          turnId: "child-turn",
          status: "inProgress",
          threadStatus: "active",
        });
      }
      if (method === "thread/turns/list") {
        return { data: [], nextCursor: null };
      }
      return undefined;
    },
    { persistedThreads: [], codexHome },
  );
  ownCodexInferenceClient(harness.client);
  const tool = createTool("owner_only_catalog_tool");
  const makeParams = (completion: boolean) => {
    const params = createParams(sessionFile, tempDir, {
      runId: completion ? "completion" : "owner",
    });
    params.agentDir = agentDir;
    params.timeoutMs = 60_000;
    params.agentHarnessCompletionScope = {
      requesterSessionKey: params.sessionKey!,
      requesterAgentId: "main",
    };
    params.privateCompletion = completion ? true : undefined;
    setCodexTestModelSupportsTools(params, true);
    params.hostCapabilities = createCodexTestHostCapabilities({
      retainSourceAuthority: completion
        ? () => undefined
        : retainSourceAuthority(new AbortController().signal),
    });
    setCodexTestToolFactory(params, () => (completion ? [] : [tool]));
    return params;
  };
  let childCompletion: Promise<unknown> | undefined;
  let continuation: ReturnType<typeof runCodexAppServerAttempt> | undefined;
  try {
    const owner = runCodexAppServerAttempt(makeParams(false));
    await owner.waitForTurnAccepted();
    expect(harness.requests.find(({ method }) => method === "thread/start")?.params).toMatchObject({
      dynamicTools: expect.arrayContaining([
        expect.objectContaining({
          name: "openclaw",
          tools: expect.arrayContaining([expect.objectContaining({ name: tool.name })]),
        }),
      ]),
    });
    await harness.notify({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          parentThreadId: "thread-1",
          source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 1 } } },
        },
      },
    });
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: directSpawnItem("v1", "thread-1", "child-thread"),
      },
    });
    expect(isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(true);
    await harness.notify(turnStartedNotification("child-turn"));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await owner;
    await nativeHookRelayUnregisterQueue.flush();
    childCompletion = harness.notify(
      childTurnCompletedNotification({
        status: "completed",
        items: [agentMessage("child-result", "completed", "final_answer")],
      }),
    );
    await entered.promise;
    // Completion custody outlives the execution pin. Catalog reuse must not repin it.
    expect(isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(false);
    expect(
      codexNativeSubagentMonitorRuntime.hasPendingCatalogCustody(harness.client, "thread-1"),
    ).toBe(true);
    const replacementClient = createClient();
    expect(
      codexNativeSubagentMonitorRuntime.hasPendingCatalogCustody(
        replacementClient.client,
        "thread-1",
      ),
    ).toBe(false);
    replacementClient.close();
    continuation = runCodexAppServerAttempt(makeParams(true));
    await continuation.waitForTurnAccepted();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
      clientId: harness.client.getInstanceId(),
    });
    expect(
      harness.requests
        .filter(({ method }) => ["thread/start", "thread/resume"].includes(method))
        .map(({ method }) => method),
    ).toEqual(["thread/start"]);
    const denied = await harness.handleServerRequest({
      id: "stale-executor",
      method: "item/tool/call",
      params: { ...createDynamicToolCall(tool.name), namespace: "openclaw" },
    });
    expect(denied).toMatchObject({ success: false });
    expect(tool.execute).not.toHaveBeenCalled();
    // The lifecycle harness joins all notification handlers, including the held child delivery.
    const parentCompletion = harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    releaseDelivery.resolve();
    await Promise.all([parentCompletion, continuation, childCompletion]);
    continuation = undefined;
    expect(
      codexNativeSubagentMonitorRuntime.hasPendingCatalogCustody(harness.client, "thread-1"),
    ).toBe(false);
    expect(runtime.deliverAgentHarnessCompletion).toHaveBeenCalledOnce();
  } finally {
    releaseDelivery.resolve();
    if (continuation) {
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await Promise.allSettled([continuation]);
    }
    await childCompletion;
    await codexNativeSubagentMonitorRuntime.retireParent(harness.client, "thread-1");
    harness.close();
  }
});
