import { describe, expect, it } from "vitest";
import type { AgentToolResult } from "../../../packages/agent-core/src/types.js";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "../../auto-reply/heartbeat-tool-response.js";
import { extractMessagingToolSourceReplyPayload } from "../embedded-agent-messaging-extraction.js";
import { collectMessagingMediaUrlsFromRecord } from "../embedded-agent-tool-media.js";
import {
  recordAgentHarnessToolResultTelemetry,
  resolveAgentHarnessToolResultPresentation,
  type AgentHarnessToolResultTelemetry,
} from "./tool-result-facts.js";

describe("resolveAgentHarnessToolResultPresentation", () => {
  it("treats accepted goal tool statuses (created / updated) as successful", () => {
    for (const status of ["created", "updated"]) {
      expect(present(textToolResult(`Goal ${status}.`, { status })).isError).toBe(false);
    }
  });

  it("treats get_goal read statuses (found / missing) as successful", () => {
    for (const status of ["found", "missing"]) {
      const result = textToolResult(JSON.stringify({ status }), {
        status,
        ...(status === "found" ? { goal: { objective: "ship the fix", status: "active" } } : {}),
      });
      expect(present(result)).toMatchObject({ result, isError: false });
    }
  });

  it.each(["pending", "applied", "rejected", "quarantined", "stale"] as const)(
    "treats Skill Workshop lifecycle status %s as successful",
    (status) => {
      const result = textToolResult(`Proposal is ${status}.`, { status });
      expect(present(result)).toMatchObject({ result, isError: false });
    },
  );

  it("treats arbitrary plugin-owned status metadata as successful by default", () => {
    const result = textToolResult("Plugin action completed.", { status: "plugin-defined-outcome" });
    expect(present(result).isError).toBe(false);
  });
});

describe("recordAgentHarnessToolResultTelemetry", () => {
  it.each([
    { toolName: "tts", mediaUrl: "/tmp/reply.opus", audioAsVoice: true },
    { toolName: "image_generate", mediaUrl: "/tmp/generated.png" },
    { toolName: "video_generate", mediaUrl: "https://media.example/video.mp4" },
    { toolName: "music_generate", mediaUrl: "https://media.example/music.wav" },
  ])("preserves structured media artifacts from $toolName tool results", (entry) => {
    const telemetry = createTelemetry();
    recordTelemetry({
      toolName: entry.toolName,
      result: {
        content: [{ type: "text", text: "Generated media reply." }],
        details: { media: { mediaUrl: entry.mediaUrl, audioAsVoice: entry.audioAsVoice } },
      },
      telemetry,
    });

    expect(telemetry.toolMediaUrls).toEqual([entry.mediaUrl]);
    expect(telemetry.toolAudioAsVoice).toBe(entry.audioAsVoice === true);
  });

  it("preserves audio-as-voice metadata from unowned tts results", () => {
    const telemetry = createTelemetry();
    recordTelemetry({
      toolName: "tts",
      result: {
        content: [{ type: "text", text: "(spoken) hello" }],
        details: {
          media: { mediaUrl: "/tmp/reply.opus", audioAsVoice: true, trustedLocalMedia: true },
        },
      },
      telemetry,
    });

    expect(telemetry.toolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(telemetry.toolAutoDeliveryMediaUrls).toEqual([]);
    expect(telemetry.toolAudioAsVoice).toBe(true);
  });

  it("records messaging tool side effects", () => {
    const telemetry = createTelemetry();
    recordTelemetry({
      toolName: "message",
      result: textToolResult("Sent.", { messageId: "message-1" }),
      args: {
        action: "send",
        text: "hello from Codex",
        mediaUrl: "/tmp/reply.png",
        provider: "telegram",
        to: "chat-1",
        threadId: "thread-ts-1",
      },
      messagingDelivered: true,
      mediaDeliveryConfirmed: true,
      telemetry,
    });

    expect(telemetry.didSendViaMessagingTool).toBe(true);
    expect(telemetry.messagingToolSentTexts).toEqual(["hello from Codex"]);
    expect(telemetry.messagingToolSentMediaUrls).toEqual(["/tmp/reply.png"]);
    expect(telemetry.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "telegram",
        to: "chat-1",
        threadId: "thread-ts-1",
        text: "hello from Codex",
        mediaUrls: ["/tmp/reply.png"],
      },
    ]);
  });

  it("accepts heartbeat response tool outcomes", () => {
    const telemetry = createTelemetry();
    recordTelemetry({
      toolName: HEARTBEAT_RESPONSE_TOOL_NAME,
      result: textToolResult("Accepted.", {
        status: "accepted",
        outcome: "needs_attention",
        notify: true,
        summary: "Build is blocked.",
        notificationText: "Build is blocked on missing credentials.",
        priority: "high",
      }),
      telemetry,
    });

    expect(telemetry.heartbeatToolResponse).toEqual({
      outcome: "needs_attention",
      notify: true,
      summary: "Build is blocked.",
      notificationText: "Build is blocked on missing credentials.",
      priority: "high",
    });
  });
});

function textToolResult(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function present(result: AgentToolResult<unknown>) {
  return resolveAgentHarnessToolResultPresentation({ result, executionIsError: false });
}

function createTelemetry(): AgentHarnessToolResultTelemetry {
  return {
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSourceReplyPayloads: [],
    confirmedMediaDeliveries: [],
    toolMediaUrls: [],
    toolAutoDeliveryMediaUrls: [],
    coreTtsToolResults: [],
    toolAudioAsVoice: false,
  };
}

function recordTelemetry(
  params: Pick<
    Parameters<typeof recordAgentHarnessToolResultTelemetry>[0],
    "toolName" | "result" | "telemetry"
  > & {
    args?: Record<string, unknown>;
    messagingDelivered?: boolean;
    mediaDeliveryConfirmed?: boolean;
  },
) {
  return recordAgentHarnessToolResultTelemetry({
    args: {},
    isError: false,
    messagingDelivered: false,
    mediaDeliveryConfirmed: false,
    extractSourceReplyPayload: extractMessagingToolSourceReplyPayload,
    collectMessagingMediaUrls: collectMessagingMediaUrlsFromRecord,
    resolveMessagingMediaSourceUrls: (urls) => urls,
    signal: new AbortController().signal,
    ...params,
  });
}
