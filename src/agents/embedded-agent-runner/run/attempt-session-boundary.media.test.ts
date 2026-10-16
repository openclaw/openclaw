import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderMessage } from "../../../../packages/ai/src/provider-types.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { attachRuntimePromptMediaFacts } from "../../../media/media-facts.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { convertToLlm } from "../../sessions/messages.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { materializeProviderContext } from "./images.js";
import {
  applyRuntimeContextCarrierRetention,
  buildRuntimeContextCustomMessage,
} from "./runtime-context-prompt.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const MP4_HEADER = Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex");

function videoBlocks(message: ProviderMessage | undefined) {
  expect(message?.role).toBe("user");
  return message?.role === "user" && Array.isArray(message.content)
    ? message.content.filter((block) => block.type === "video")
    : [];
}

describe("native video at the session conversion boundary", () => {
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

    const historical = Object.freeze(
      buildPersistedUserTurnMessage({
        text: "Historical video",
        timestamp: 1,
        media: [{ path: historicalPath, contentType: "video/mp4", kind: "video" }],
      }),
    );
    const current = attachRuntimePromptMediaFacts(
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Current video" }],
        timestamp: 2,
      },
      [{ path: currentPath, contentType: "video/mp4", kind: "video" }],
    );
    // No persisted media here: only the runtime carrier can preserve this clip.
    // Both prompt and sender projections replace the current message object.
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
    const queued: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: "Queued text without an attachment" }],
      timestamp: 3,
    };
    const original: AgentMessage[] = [historical, current, carrier];
    const originalJson = JSON.stringify(original);
    const queuedJson = JSON.stringify(queued);
    const transcriptJson = JSON.stringify(currentTranscript);
    const project = async (messages: AgentMessage[]) => {
      const normalized = normalizeMessagesForLlmBoundary(messages, {
        sessionVersion: 4,
        appendOnlyRuntimeContext: true,
        timezone: "UTC",
        userTranscriptContexts: [{ runtimeMessage: current, transcriptMessage: currentTranscript }],
      });
      const converted = convertToLlm(normalized);
      applyRuntimeContextCarrierRetention(converted, true);
      return await materializeProviderContext({
        context: {
          systemPrompt: "Inspect only attachments belonging to each turn.",
          messages: converted,
          tools: [],
        },
        workspaceDir,
        localRoots: [workspaceDir],
      });
    };

    for (const messages of [original, [...original, queued]]) {
      const provider = await project(messages);
      expect(provider.messages).toHaveLength(messages.length);
      expect(videoBlocks(provider.messages[0])).toEqual([
        { type: "video", data: historicalVideo.toString("base64"), mimeType: "video/mp4" },
      ]);
      expect(videoBlocks(provider.messages[1])).toEqual([
        { type: "video", data: currentVideo.toString("base64"), mimeType: "video/mp4" },
      ]);
      expect(provider.messages[1]?.content).toContainEqual({
        type: "text",
        text: expect.stringContaining("Projected current video"),
      });
      expect(provider.messages[1]?.content).toContainEqual({
        type: "text",
        text: expect.stringContaining("Video sender"),
      });
      expect(provider.messages[2]).toMatchObject({
        runtimeContextCarrier: true,
        runtimeContextCarrierRetained: true,
      });
      expect(videoBlocks(provider.messages[2])).toEqual([]);
      if (messages.length === 4) {
        expect(provider.messages[3]?.content).toContain("Queued text without an attachment");
        expect(videoBlocks(provider.messages[3])).toEqual([]);
      }
    }
    expect(JSON.stringify(original)).toBe(originalJson);
    expect(JSON.stringify(queued)).toBe(queuedJson);
    expect(JSON.stringify(currentTranscript)).toBe(transcriptJson);
  });
});
