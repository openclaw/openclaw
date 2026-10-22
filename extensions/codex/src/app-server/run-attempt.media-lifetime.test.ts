import assert from "node:assert/strict";
import path from "node:path";
import { createHostTtsRuntimeContract } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi, type MockInstance } from "vitest";
import * as dynamicTools from "./dynamic-tools.js";
import { installResultMiddleware } from "./dynamic-tools.test-support.js";
import {
  createTestParams,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

it("delivers earlier accepted TTS but discards audio whose result timed out", async () => {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  installResultMiddleware(async (event) => {
    if (event.toolCallId === "host-tts") {
      entered.resolve();
      await release.promise;
    }
    return { result: event.result };
  });
  const createBridge = vi.spyOn(dynamicTools, "createCodexDynamicToolBridge");
  const harness = createStartedThreadHarness();
  const params = createTestParams();
  params.runtimePlan = createCodexRuntimePlanFixture();
  params.sourceReplyDeliveryMode = "message_tool_only";
  params.toolsAllow = ["tts"];
  setCodexTestModelSupportsTools(params, true);
  const earlierPath = path.join(tempDir, "earlier.opus");
  const host = await createHostTtsRuntimeContract(params, path.join(tempDir, "reply.opus"), {
    nativeModelPolicySupport: "exact",
  });
  params.hostCapabilities = host.hostCapabilities;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const run = runCodexAppServerAttempt(params);
  const attemptEnded = run.then(() => {
    throw new Error("Codex attempt settled before the expected fixture progress");
  });
  let handle:
    | MockInstance<ReturnType<typeof dynamicTools.createCodexDynamicToolBridge>["handleToolCall"]>
    | undefined;
  try {
    await run.waitForTurnAccepted();
    const bridge = createBridge.mock.results[0]?.value;
    assert(bridge, "Expected the attempt's real dynamic tool bridge");
    handle = vi.spyOn(bridge, "handleToolCall");
    host.synthesis.mockResolvedValueOnce({
      success: true,
      audioPath: earlierPath,
      provider: "test-speech",
      audioAsVoice: true,
    });
    const speak = (callId: string, args: { text: string; timeoutMs?: number }) =>
      harness.handleServerRequest({
        id: callId,
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId,
          namespace: null,
          tool: "tts",
          arguments: args,
        },
      });
    expect(await speak("earlier-tts", { text: "Earlier accepted audio." })).toMatchObject({
      success: true,
    });
    const response = speak("host-tts", { text: "Read this aloud.", timeoutMs: 1 });
    await Promise.race([
      entered.promise,
      attemptEnded,
      response.then(() => {
        throw new Error("TTS request settled before entering result middleware");
      }),
    ]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await response).toMatchObject({ success: false });
    release.resolve();
    // The watchdog winner does not await its losing middleware continuation.
    await Promise.all(handle.mock.results.map((entry) => entry.value));
    expect(await response).toMatchObject({ success: false });
    expect(host.synthesis).toHaveBeenCalledTimes(2);
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;
    expect(host.deliverablePayloads(result)).toEqual([
      expect.objectContaining({
        mediaUrls: [earlierPath],
        audioAsVoice: true,
        trustedLocalMedia: true,
      }),
    ]);
    expect(result.toolMediaUrls).toEqual([earlierPath]);
  } finally {
    release.resolve();
    await Promise.allSettled(handle?.mock.results.map((entry) => entry.value) ?? []);
    vi.useRealTimers();
    host.close();
  }
});
