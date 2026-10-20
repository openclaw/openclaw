import { describe, expect, it } from "vitest";
import { HEARTBEAT_RESPONSE_TOOL_NAME } from "../../auto-reply/heartbeat-tool-response.js";
import {
  collectMessagingMediaUrlsFromRecord,
  collectMessagingMediaUrlsFromToolResult,
} from "../embedded-agent-tool-media.js";
import { resolveAgentHarnessToolResultPresentation } from "./tool-result-facts.js";
import {
  createTelemetry,
  recordTelemetry,
  textToolResult,
} from "./tool-result-facts.test-support.js";

describe("resolveAgentHarnessToolResultPresentation", () => {
  it.each(["rejected", "plugin-defined-outcome"])(
    "treats plugin-owned status %s as successful by default",
    (status) => {
      const result = textToolResult(`Proposal is ${status}.`, { status });
      expect(
        resolveAgentHarnessToolResultPresentation({ result, executionIsError: false }),
      ).toMatchObject({ result, isError: false });
    },
  );
});

describe("recordAgentHarnessToolResultTelemetry", () => {
  it("combines direct, detail and JSON tool-result media in first-seen order", () => {
    expect(
      collectMessagingMediaUrlsFromToolResult({
        media: "first.png",
        details: { mediaUrls: ["first.png", "second.png"] },
        content: [
          { type: "text", text: JSON.stringify({ filePath: "third.png", mediaUrl: "second.png" }) },
        ],
      }),
    ).toEqual(["first.png", "second.png", "third.png"]);
  });

  it("keeps canonical message references deduplicated without accepting harness aliases", () => {
    expect(
      collectMessagingMediaUrlsFromRecord({
        media: " same.png ",
        mediaUrl: "same.png",
        media_url: "ignored-scalar.png",
        imageUrl: "ignored-image.png",
        mediaUrls: ["same.png", "array.png"],
        media_urls: ["ignored-array.png"],
        attachments: [{ filePath: "attached.png", url: "same.png", caption: "ignored.png" }],
      }),
    ).toEqual(["same.png", "array.png", "attached.png"]);
  });

  it.each([
    { toolName: "image_generate", media: { mediaUrl: "/tmp/generated.png" }, voice: false },
    {
      toolName: "tts",
      media: { mediaUrl: "/tmp/reply.opus", audioAsVoice: true, trustedLocalMedia: true },
      voice: true,
    },
  ])(
    "preserves $toolName media and voice metadata without unowned auto-delivery",
    ({ toolName, media, voice }) => {
      const telemetry = createTelemetry();
      recordTelemetry({
        toolName,
        result: textToolResult("Generated media.", { media }),
        telemetry,
      });

      expect(telemetry).toMatchObject({
        toolMediaUrls: [media.mediaUrl],
        toolAutoDeliveryMediaUrls: [],
        toolAudioAsVoice: voice,
      });
    },
  );

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

    expect(telemetry).toMatchObject({
      didSendViaMessagingTool: true,
      messagingToolSentTexts: ["hello from Codex"],
      messagingToolSentMediaUrls: ["/tmp/reply.png"],
    });
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
    const response = {
      outcome: "needs_attention",
      notify: true,
      summary: "Build is blocked.",
      notificationText: "Build is blocked on missing credentials.",
      priority: "high",
    };
    recordTelemetry({
      toolName: HEARTBEAT_RESPONSE_TOOL_NAME,
      result: textToolResult("Accepted.", { status: "accepted", ...response }),
      telemetry,
    });

    expect(telemetry.heartbeatToolResponse).toEqual(response);
  });
});
