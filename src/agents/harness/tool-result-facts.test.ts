import { expect, it } from "vitest";
import {
  collectMessagingMediaUrlsFromRecord,
  collectMessagingMediaUrlsFromToolResult,
} from "../embedded-agent-tool-media.js";
import { resolveAgentHarnessToolResultPresentation } from "./tool-result-facts.js";
import { recordTelemetry, textToolResult } from "./tool-result-facts.test-support.js";

it.each(["rejected", "plugin-defined-outcome"])(
  "treats plugin-owned status %s as successful by default",
  (status) => {
    const result = textToolResult(`Proposal is ${status}.`, { status });
    expect(
      resolveAgentHarnessToolResultPresentation({ result, executionIsError: false }),
    ).toMatchObject({ result, isError: false });
  },
);
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
  ["image_generate", { mediaUrl: "/tmp/generated.png" }, false],
  ["tts", { mediaUrl: "/tmp/reply.opus", audioAsVoice: true, trustedLocalMedia: true }, true],
] as const)(
  "preserves %s media and voice metadata without unowned auto-delivery",
  (toolName, media, voice) => {
    const telemetry = recordTelemetry({
      toolName,
      result: textToolResult("Generated media.", { media }),
    });

    expect(telemetry).toMatchObject({
      toolMediaUrls: [media.mediaUrl],
      toolAutoDeliveryMediaUrls: [],
      toolAudioAsVoice: voice,
    });
  },
);

it("records messaging tool side effects", () => {
  const target = {
    provider: "telegram",
    to: "chat-1",
    threadId: "thread-ts-1",
    text: "hello from Codex",
  };
  const telemetry = recordTelemetry({
    toolName: "message",
    result: textToolResult("Sent.", { messageId: "message-1" }),
    args: {
      action: "send",
      mediaUrl: "/tmp/reply.png",
      ...target,
    },
    messagingDelivered: true,
    mediaDeliveryConfirmed: true,
  });

  expect(telemetry).toMatchObject({
    didSendViaMessagingTool: true,
    messagingToolSentTexts: ["hello from Codex"],
    messagingToolSentMediaUrls: ["/tmp/reply.png"],
  });
  expect(telemetry.messagingToolSentTargets).toEqual([
    {
      ...target,
      tool: "message",
      mediaUrls: ["/tmp/reply.png"],
    },
  ]);
});
