import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { shouldDeliverDespiteSourceReplySuppression } from "../auto-reply/reply/dispatch-from-config.payloads.js";
import * as ttsRuntime from "../tts/tts.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import { resetCodeModeTestState, runUntilCompleted } from "./code-mode.test-support.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import { resolveToolSearchConfig } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import { createTtsTool } from "./tools/tts-tool.js";

const audioPath = "/tmp/nested-tts-reply.mp3";
const speechResult = { success: true, audioPath, provider: "test" };
const suppressionState = {
  ctx: {},
  explicitCommandTurnCtx: false,
  suppressAutomaticSourceDelivery: true,
  sendPolicyDenied: false,
};
const harnesses: Array<{ dispose: () => void }> = [];

function createTtsHarness(name: string, target: AnyAgentTool = createTtsTool({ config: {} })) {
  const delivered: ReplyPayload[] = [];
  const harness = createSubscribedCodeModeHarness({
    name,
    sourceReplyDeliveryMode: "message_tool_only",
    onBlockReply: (payload) => {
      if (shouldDeliverDespiteSourceReplySuppression(payload, suppressionState)) {
        delivered.push(payload);
      }
    },
  });
  harnesses.push(harness);
  applyCodeModeCatalog({ ...harness, tools: [...harness.tools, target] });
  const runtime = new ToolSearchRuntime(harness, resolveToolSearchConfig(harness.config));
  return { ...harness, runtime, delivered };
}

async function finishReply(harness: ReturnType<typeof createTtsHarness>, text = "") {
  const message = {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    stopReason: "stop",
  };
  harness.emit({ type: "message_start", message });
  harness.emit({ type: "message_end", message });
  harness.emit({ type: "agent_end", messages: [message], willRetry: false });
  await harness.subscription.waitForPendingEvents();
}

describe("Code Mode nested TTS delivery", () => {
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
      harness.dispose();
    }
    await resetCodeModeTestState();
    vi.restoreAllMocks();
  });

  it("delivers accepted speech with a private final", async () => {
    const synthesize = vi.spyOn(ttsRuntime, "textToSpeech").mockResolvedValue(speechResult);
    const harness = createTtsHarness("private");
    const result = await runUntilCompleted({
      execTool: expectDefined(harness.tools[0], "Code Mode exec tool"),
      waitTool: expectDefined(harness.tools[1], "Code Mode wait tool"),
      code: 'return await tts({ text: "Synthetic speech" });',
    });
    expect(result.status).toBe("completed");
    expect(synthesize).toHaveBeenCalledOnce();
    await finishReply(harness, "Private final text must not be sent.");

    expect(harness.delivered).toEqual([
      expect.objectContaining({ mediaUrl: audioPath, mediaUrls: [audioPath] }),
    ]);
    expect(harness.delivered[0]?.text).toBeUndefined();
    expect(
      shouldDeliverDespiteSourceReplySuppression(
        expectDefined(harness.delivered[0], "delivered speech"),
        { ...suppressionState, sendPolicyDenied: true },
      ),
    ).toBe(false);
  });

  it("does not authorize same-shaped unmarked media", async () => {
    const target = createTtsTool({ config: {} });
    target.execute = vi.fn(async () =>
      jsonResult({ media: { mediaUrl: audioPath, trustedLocalMedia: true } }),
    );
    const harness = createTtsHarness("unmarked", target);
    await harness.runtime.call("tts", { text: "Synthetic speech" });
    expect(target.execute).toHaveBeenCalledOnce();
    await finishReply(harness, "Private final text.");
    expect(harness.delivered).toEqual([]);
  });

  it("does not deliver synthesized speech rejected by output acceptance", async () => {
    const synthesize = vi.spyOn(ttsRuntime, "textToSpeech").mockResolvedValue(speechResult);
    const target = createTtsTool({ config: {} });
    target.outputSchema = Type.Object({ accepted: Type.Boolean() });
    const harness = createTtsHarness("rejected-output", target);
    await expect(harness.runtime.call("tts", { text: "Synthetic speech" })).rejects.toThrow(
      "returned details that do not match its declared outputSchema",
    );
    expect(synthesize).toHaveBeenCalledOnce();
    await finishReply(harness);
    expect(harness.delivered).toEqual([]);
    expect(harness.subscription.toolMetas).toEqual([
      expect.objectContaining({ toolName: "tts", isError: true }),
    ]);
  });

  it("does not publish a raw speech result that completes after cancellation", async () => {
    const started = createDeferred();
    const releaseSpeech = createDeferred();
    vi.spyOn(ttsRuntime, "textToSpeech").mockImplementation(async () => {
      started.resolve();
      await releaseSpeech.promise;
      return speechResult;
    });
    const target = createTtsTool({ config: {} });
    const execute = vi.spyOn(target, "execute");
    const harness = createTtsHarness("late-abort", target);
    const lifecycle = vi.spyOn(harness.subscription, "runToolLifecycle");
    try {
      const call = harness.runtime.call("tts", { text: "Synthetic speech" });
      const rejected = expect(call).rejects.toMatchObject({ name: "AbortError" });
      await started.promise;
      harness.runAbortController.abort(new Error("cancel nested speech"));
      await rejected;
      // The outer abort race settles before nested terminal cleanup finishes.
      await expect(lifecycle.mock.results[0]?.value).rejects.toMatchObject({ name: "AbortError" });
      releaseSpeech.resolve();
      await expect(execute.mock.results[0]?.value).resolves.toMatchObject({
        details: { audioPath },
      });
      await finishReply(harness);
      expect(harness.delivered).toEqual([]);
    } finally {
      releaseSpeech.resolve();
    }
  });
});
