import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ProviderMessage } from "../../../../packages/ai/src/provider-types.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { cloneTranscriptView } from "../../../config/sessions/transcript-snapshot.js";
import { attachRuntimePromptMediaFacts } from "../../../media/media-facts.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";
import { freezeJsonSnapshot, isDeeplyFrozenPlainData } from "../../../shared/immutable-data.js";
import type { AgentMessage } from "../../runtime/index.js";
import { convertToLlm, convertToLlmWithBlockImages } from "../../sessions/messages.js";
import {
  createToolResultPromptProjectionState,
  recordToolResultPromptProjection,
} from "../session-prompt-state.js";
import { bindToolResultPromptProjectionKeys } from "../tool-result-projection-key.js";
import { replayToolResultPromptProjections } from "../tool-result-projection-replay.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { materializeProviderContext } from "./images.js";
import {
  applyRuntimeContextCarrierRetention,
  buildRuntimeContextCustomMessage,
  buildSystemUpdateMessage,
} from "./runtime-context-prompt.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const MP4_HEADER = Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex");

function userMessage(text: string, timestamp: number) {
  return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp };
}

function videoBlocks(message: ProviderMessage | undefined) {
  expect(message?.role).toBe("user");
  return message?.role === "user" && Array.isArray(message.content)
    ? message.content.filter((block) => block.type === "video")
    : [];
}

it("keeps historical and runtime video on their own turns across queued text and carriers", async () => {
  const workspaceDir = tempDirs.make("openclaw-video-boundary-");
  const historicalVideo = Buffer.concat([MP4_HEADER, Buffer.from([0x11])]);
  const currentVideo = Buffer.concat([MP4_HEADER, Buffer.from([0x22])]);
  const historicalPath = path.join(workspaceDir, "historical.mp4");
  const currentPath = path.join(workspaceDir, "current.mp4");
  await Promise.all([
    fs.writeFile(historicalPath, historicalVideo),
    fs.writeFile(currentPath, currentVideo),
  ]);

  const historical = buildPersistedUserTurnMessage({
    text: "Historical video",
    timestamp: 1,
    media: [{ path: historicalPath, contentType: "video/mp4", kind: "video" }],
  });
  Object.freeze(historical);
  const current = attachRuntimePromptMediaFacts(userMessage("Current video", 2), [
    { path: currentPath, contentType: "video/mp4", kind: "video" },
  ]);
  // Prompt/sender projection must preserve media held only by the runtime carrier.
  const currentTranscript: PersistedUserTurnMessage = {
    role: "user",
    content: "Current video",
    timestamp: 2,
    __openclaw: {
      senderName: "Video sender",
      modelPromptProjection: { version: 1, text: "Projected current video" },
    },
  };
  const carrier = buildRuntimeContextCustomMessage("Current turn context")!;
  const queued = userMessage("Queued text without an attachment", 3);
  const original: AgentMessage[] = [historical, current, carrier];
  const inputs = [original, queued, currentTranscript];
  const originalJson = JSON.stringify(inputs);
  for (const messages of [original, [...original, queued]]) {
    const normalized = normalizeMessagesForLlmBoundary(messages, {
      sessionVersion: 4,
      appendOnlyRuntimeContext: true,
      timezone: "UTC",
      userTranscriptContexts: [{ runtimeMessage: current, transcriptMessage: currentTranscript }],
    });
    const converted = convertToLlm(normalized);
    applyRuntimeContextCarrierRetention(converted, true);
    const provider = await materializeProviderContext({
      context: { messages: converted },
      workspaceDir,
      localRoots: [workspaceDir],
    });
    const expectedVideos = [historicalVideo, currentVideo].map((video) => [
      { type: "video", data: video.toString("base64"), mimeType: "video/mp4" },
    ]);
    expect(provider.messages.map(videoBlocks)).toEqual([
      ...expectedVideos,
      [],
      ...(messages.length === 4 ? [[]] : []),
    ]);
    for (const text of ["Projected current video", "Video sender"]) {
      expect(provider.messages[1]?.content).toContainEqual({
        type: "text",
        text: expect.stringContaining(text),
      });
    }
    expect(provider.messages[2]).toMatchObject({
      runtimeContextCarrier: true,
      runtimeContextCarrierRetained: true,
    });
    if (messages.length === 4) {
      expect(provider.messages[3]?.content).toContain("Queued text without an attachment");
    }
  }
  expect(JSON.stringify(inputs)).toBe(originalJson);
});

it("reuses frozen request projections while isolating image, replay, and retention policies", () => {
  const tool = freezeJsonSnapshot({
    role: "toolResult" as const,
    toolCallId: "call",
    toolName: "read",
    isError: false,
    content: [{ type: "text" as const, text: "full result" }],
    details: { internal: true },
    timestamp: 2,
  });
  const source: AgentMessage[] = freezeJsonSnapshot([
    { role: "user", content: "hello", timestamp: 1 },
    tool,
    { role: "custom", customType: "note", content: "note", display: false, timestamp: 3 },
    buildRuntimeContextCustomMessage("runtime facts")!,
    buildSystemUpdateMessage("update", "prompt-update", true),
    {
      role: "user",
      content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      timestamp: 6,
    },
  ]);
  const state = createToolResultPromptProjectionState();
  recordToolResultPromptProjection(state, "tool:call:2", {
    ...tool,
    content: [{ type: "text", text: "short result" }],
  });
  const otherState = createToolResultPromptProjectionState();
  recordToolResultPromptProjection(otherState, "tool:call:2", {
    ...tool,
    content: [{ type: "text", text: "other limit" }],
  });
  const prepare = (
    blockImages: boolean,
    retained: boolean | undefined,
    updates = true,
    projections = state,
  ) => {
    const messages = bindToolResultPromptProjectionKeys(
      cloneTranscriptView(source),
      createToolResultPromptProjectionState(projections),
    );
    const normalized = normalizeMessagesForLlmBoundary(
      replayToolResultPromptProjections(messages, projections),
      {
        sessionVersion: 4,
        includeTimestamp: false,
        appendOnlyRuntimeContext: true,
        inHistorySystemUpdates: updates,
      },
    );
    const converted = convertToLlmWithBlockImages(normalized, blockImages);
    applyRuntimeContextCarrierRetention(converted, retained);
    return converted;
  };
  const first = prepare(false, true);
  const bytes = JSON.stringify(first);
  expect(first[1]).toMatchObject({ content: [{ type: "text", text: "short result" }] });
  expect(first[1]).not.toHaveProperty("details");
  expect(first[2]).toMatchObject({
    role: "user",
    content: [{ type: "text", text: "note" }],
    synthetic: true,
  });
  for (const retained of [false, undefined, true]) {
    const other = prepare(true, retained, false, otherState);
    expect(other[1]).toMatchObject({ content: [{ type: "text", text: "other limit" }] });
    expect(other[3]).toHaveProperty("runtimeContext.retained", retained);
    expect(other[4]).not.toHaveProperty("operatorMessage");
    expect(other[5]).toMatchObject({
      content: [{ type: "text", text: "Image reading is disabled." }],
    });
    const next = prepare(false, true);
    expect(JSON.stringify(next)).toBe(bytes);
    next.forEach((message, index) => {
      expect(message).toBe(first[index]);
      expect(isDeeplyFrozenPlainData(message)).toBe(true);
    });
  }
  expect(tool.content[0]?.text).toBe("full result");
  expect(tool.details).toEqual({ internal: true });
});

it("recomputes mutable projections, including shallow-frozen sources and replacement edits", () => {
  const protectedText = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
  for (const role of ["user", "custom"] as const) {
    const source = {
      role,
      customType: "note",
      display: false,
      content: [
        { type: "text" as const, text: protectedText },
        { type: "text" as const, text: "second block" },
      ],
      timestamp: 1,
    };
    const projected = normalizeMessagesForLlmBoundary([source], {
      sessionVersion: 4,
      includeTimestamp: false,
    });
    expect(projected[0]).not.toBe(source);
    const message = projected[0]!;
    if ((message.role !== "user" && message.role !== "custom") || !Array.isArray(message.content)) {
      throw new Error("Expected projected text blocks");
    }
    const block = message.content[0]!;
    expect(block).not.toBe(source.content[0]);
    if (block.type !== "text") {
      throw new Error("Expected projected text");
    }
    expect(block.text).toBe("[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]");
    block.text = "changed";
    expect(source.content[0]!.text).toBe(protectedText);
  }
  const custom = {
    role: "custom" as const,
    customType: "note",
    content: [{ type: "text" as const, text: "before" }],
    display: false,
    timestamp: 1,
  };
  Object.freeze(custom);
  const first = convertToLlm([custom]);
  custom.content[0]!.text = "after";
  const second = convertToLlm([custom]);
  expect(second[0]).not.toBe(first[0]);
  expect(second[0]?.content).toEqual([{ type: "text", text: "after" }]);
  expect(Object.isFrozen(custom.content)).toBe(false);
  const tool = freezeJsonSnapshot({
    role: "toolResult" as const,
    toolCallId: "call",
    toolName: "read",
    content: [{ type: "text" as const, text: "full" }],
    isError: false,
    timestamp: 2,
  });
  const state = createToolResultPromptProjectionState();
  const replacement = { content: [{ type: "text" as const, text: "first" }] };
  state.replacements.set("tool:call:2", replacement);
  expect(replayToolResultPromptProjections([tool], state)[0]).toMatchObject({
    content: [{ type: "text", text: "first" }],
  });
  replacement.content[0]!.text = "second";
  expect(replayToolResultPromptProjections([tool], state)[0]).toMatchObject({
    content: [{ type: "text", text: "second" }],
  });
  expect(Object.isFrozen(replacement.content)).toBe(false);
});
