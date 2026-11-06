import { expect, it } from "vitest";
import {
  collectMessagingMediaUrlsFromRecord,
  collectMessagingMediaUrlsFromToolResult,
} from "../embedded-agent-tool-media.js";
import { resolveAgentHarnessToolResultPresentation } from "./tool-result-facts.js";
import { appendUnscheduledReminderNote } from "../../auto-reply/reply/agent-runner-reminder-guard.js";
import { normalizeToolPolicyName } from "../tool-policy.js";
import { stripOpenClawMcpToolPrefix } from "../tool-display-call.js";
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

it.each(["automations", "cron"] as const)(
  "counts a successful %s add as a committed reminder",
  (toolName) => {
    const telemetry = recordTelemetry({
      toolName,
      args: { action: "add", job: { name: "Remind me Sunday at 9am" } },
      result: textToolResult("Scheduled.", { id: "job-1", nextRunAtMs: 1 }),
    });
    expect(telemetry.successfulCronAdds).toBe(1);
  },
);

it("does not count a failed or non-add scheduler call as a committed reminder", () => {
  for (const [toolName, args, isError] of [
    ["automations", { action: "add" }, true],
    ["automations", { action: "list" }, false],
    ["cron", { action: "remove" }, false],
    ["message", { action: "add" }, false],
  ] as const) {
    const telemetry = recordTelemetry({ toolName, args, isError });
    expect(telemetry.successfulCronAdds, `${toolName} ${args.action}`).toBeUndefined();
  }
});

it("suppresses the reminder guard note for an MCP-exposed automations add", () => {
  // Production shape: the CLI child names the loopback tool mcp__openclaw__automations and
  // cli-backend-dispatch normalizes it before telemetry sees it.
  const toolName = normalizeToolPolicyName(stripOpenClawMcpToolPrefix("mcp__openclaw__automations"));
  const telemetry = recordTelemetry({
    toolName,
    args: { action: "add", schedule: { kind: "at", at: "2026-11-08T09:00:00Z" }, text: "register for X" },
    result: textToolResult("Scheduled reminder.", { job: { id: "job-1", enabled: true } }),
  });
  const reply = [{ text: "I'll remind you Sunday at 9." }];
  const payloads = telemetry.successfulCronAdds ? reply : appendUnscheduledReminderNote(reply);

  expect(toolName).toBe("automations");
  expect(payloads).toEqual(reply);
});

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
