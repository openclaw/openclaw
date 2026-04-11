import { describe, expect, it } from "vitest";
import {
  parseQQBotPayload,
  encodePayloadForCron,
  decodeCronPayload,
  isCronReminderPayload,
  isMediaPayload,
} from "./payload.js";
import type { CronReminderPayload, MediaPayload, QQBotPayload } from "./payload.js";

describe("parseQQBotPayload", () => {
  it("returns isPayload=false for plain text", () => {
    const result = parseQQBotPayload("Hello, world!");
    expect(result.isPayload).toBe(false);
    expect(result.text).toBe("Hello, world!");
    expect(result.payload).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it("returns isPayload=false when prefix is only a substring", () => {
    const result = parseQQBotPayload("some QQBOT_PAYLOAD: data");
    expect(result.isPayload).toBe(false);
  });

  it("parses a valid cron_reminder payload", () => {
    const payload: CronReminderPayload = {
      type: "cron_reminder",
      content: "Meeting in 5 minutes",
      targetType: "c2c",
      targetAddress: "user123",
    };
    const input = `QQBOT_PAYLOAD:${JSON.stringify(payload)}`;
    const result = parseQQBotPayload(input);
    expect(result.isPayload).toBe(true);
    expect(result.payload).toEqual(payload);
    expect(result.error).toBeUndefined();
  });

  it("parses a valid media payload", () => {
    const payload: MediaPayload = {
      type: "media",
      mediaType: "image",
      source: "url",
      path: "https://example.com/img.png",
    };
    const input = `QQBOT_PAYLOAD:${JSON.stringify(payload)}`;
    const result = parseQQBotPayload(input);
    expect(result.isPayload).toBe(true);
    expect(result.payload).toEqual(payload);
  });

  it("parses media payload with caption", () => {
    const payload: MediaPayload = {
      type: "media",
      mediaType: "audio",
      source: "file",
      path: "/tmp/audio.silk",
      caption: "Voice memo",
    };
    const input = `QQBOT_PAYLOAD:${JSON.stringify(payload)}`;
    const result = parseQQBotPayload(input);
    expect(result.isPayload).toBe(true);
    expect(result.payload).toEqual(payload);
  });

  it("returns error when payload body is empty", () => {
    const result = parseQQBotPayload("QQBOT_PAYLOAD:");
    expect(result.isPayload).toBe(true);
    expect(result.error).toBe("Payload body is empty");
  });

  it("returns error when payload body is whitespace only", () => {
    const result = parseQQBotPayload("QQBOT_PAYLOAD:   ");
    expect(result.isPayload).toBe(true);
    expect(result.error).toBe("Payload body is empty");
  });

  it("returns error when JSON is invalid", () => {
    const result = parseQQBotPayload("QQBOT_PAYLOAD:not-json");
    expect(result.isPayload).toBe(true);
    expect(result.error).toContain("Failed to parse JSON");
  });

  it("returns error when type field is missing", () => {
    const result = parseQQBotPayload('QQBOT_PAYLOAD:{"content":"hi"}');
    expect(result.isPayload).toBe(true);
    expect(result.error).toBe("Payload is missing the type field");
  });

  it("returns error when cron_reminder is missing required fields", () => {
    const result = parseQQBotPayload(
      'QQBOT_PAYLOAD:{"type":"cron_reminder","content":"hi"}',
    );
    expect(result.isPayload).toBe(true);
    expect(result.error).toContain("missing required fields");
  });

  it("returns error when media is missing required fields", () => {
    const result = parseQQBotPayload(
      'QQBOT_PAYLOAD:{"type":"media","mediaType":"image"}',
    );
    expect(result.isPayload).toBe(true);
    expect(result.error).toContain("missing required fields");
  });

  it("handles payload with leading/trailing whitespace", () => {
    const payload: CronReminderPayload = {
      type: "cron_reminder",
      content: "Test",
      targetType: "group",
      targetAddress: "group456",
    };
    const input = `  QQBOT_PAYLOAD:${JSON.stringify(payload)}  `;
    const result = parseQQBotPayload(input);
    expect(result.isPayload).toBe(true);
    expect(result.payload).toEqual(payload);
  });
});

describe("encodePayloadForCron / decodeCronPayload", () => {
  const samplePayload: CronReminderPayload = {
    type: "cron_reminder",
    content: "Standup meeting",
    targetType: "c2c",
    targetAddress: "openid-abc",
    originalMessageId: "msg-001",
  };

  it("round-trips a cron reminder payload", () => {
    const encoded = encodePayloadForCron(samplePayload);
    expect(encoded).toMatch(/^QQBOT_CRON:/);

    const decoded = decodeCronPayload(encoded);
    expect(decoded.isCronPayload).toBe(true);
    expect(decoded.payload).toEqual(samplePayload);
    expect(decoded.error).toBeUndefined();
  });

  it("round-trips a payload without optional fields", () => {
    const minimal: CronReminderPayload = {
      type: "cron_reminder",
      content: "Ping",
      targetType: "group",
      targetAddress: "group-xyz",
    };
    const encoded = encodePayloadForCron(minimal);
    const decoded = decodeCronPayload(encoded);
    expect(decoded.isCronPayload).toBe(true);
    expect(decoded.payload).toEqual(minimal);
  });

  it("returns isCronPayload=false for non-cron strings", () => {
    const result = decodeCronPayload("just a regular message");
    expect(result.isCronPayload).toBe(false);
    expect(result.payload).toBeUndefined();
  });

  it("returns error when cron payload body is empty", () => {
    const result = decodeCronPayload("QQBOT_CRON:");
    expect(result.isCronPayload).toBe(true);
    expect(result.error).toBe("Cron payload body is empty");
  });

  it("returns error when base64 is invalid", () => {
    const result = decodeCronPayload("QQBOT_CRON:!!not-base64!!");
    expect(result.isCronPayload).toBe(true);
    expect(result.error).toContain("Failed to decode cron payload");
  });

  it("returns error when decoded JSON has wrong type", () => {
    const wrongType = { type: "media", mediaType: "image", source: "url", path: "/x" };
    const b64 = Buffer.from(JSON.stringify(wrongType), "utf-8").toString("base64");
    const result = decodeCronPayload(`QQBOT_CRON:${b64}`);
    expect(result.isCronPayload).toBe(true);
    expect(result.error).toContain("Expected type cron_reminder");
  });

  it("returns error when decoded cron payload is missing required fields", () => {
    const incomplete = { type: "cron_reminder", content: "hi" };
    const b64 = Buffer.from(JSON.stringify(incomplete), "utf-8").toString("base64");
    const result = decodeCronPayload(`QQBOT_CRON:${b64}`);
    expect(result.isCronPayload).toBe(true);
    expect(result.error).toContain("missing required fields");
  });

  it("handles cron payload with leading/trailing whitespace", () => {
    const encoded = encodePayloadForCron(samplePayload);
    const result = decodeCronPayload(`  ${encoded}  `);
    expect(result.isCronPayload).toBe(true);
    expect(result.payload).toEqual(samplePayload);
  });
});

describe("isCronReminderPayload / isMediaPayload", () => {
  const cronPayload: QQBotPayload = {
    type: "cron_reminder",
    content: "Test",
    targetType: "c2c",
    targetAddress: "user1",
  };
  const mediaPayload: QQBotPayload = {
    type: "media",
    mediaType: "video",
    source: "url",
    path: "https://example.com/vid.mp4",
  };

  it("isCronReminderPayload returns true for cron_reminder", () => {
    expect(isCronReminderPayload(cronPayload)).toBe(true);
  });

  it("isCronReminderPayload returns false for media", () => {
    expect(isCronReminderPayload(mediaPayload)).toBe(false);
  });

  it("isMediaPayload returns true for media", () => {
    expect(isMediaPayload(mediaPayload)).toBe(true);
  });

  it("isMediaPayload returns false for cron_reminder", () => {
    expect(isMediaPayload(cronPayload)).toBe(false);
  });
});
