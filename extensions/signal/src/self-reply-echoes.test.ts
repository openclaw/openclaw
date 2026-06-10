import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasSignalSelfReplyEcho,
  rememberSignalSelfReplyEcho,
  resolveSignalSelfReplyMediaEchoText,
} from "./self-reply-echoes.js";

describe("signal self-reply echoes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses short text fallback only for timestamp-less echoes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    await rememberSignalSelfReplyEcho({
      accountId: "default",
      messageId: "1000",
      timestamp: 1000,
      text: "same reply",
    });

    expect(
      await hasSignalSelfReplyEcho({
        accountId: "default",
        messageId: "2000",
        timestamp: 2000,
        text: "same reply",
      }),
    ).toBe(false);
    expect(
      await hasSignalSelfReplyEcho({
        accountId: "default",
        messageId: "1000",
        timestamp: 1000,
      }),
    ).toBe(true);

    await rememberSignalSelfReplyEcho({
      accountId: "default",
      messageId: "unknown",
      text: "timestamp-less reply",
    });

    const sentAt = Date.now();

    expect(
      await hasSignalSelfReplyEcho({
        accountId: "default",
        messageId: String(sentAt + 1_000),
        timestamp: sentAt + 1_000,
        text: "timestamp-less reply",
      }),
    ).toBe(false);
    expect(
      await hasSignalSelfReplyEcho({
        accountId: "default",
        text: "timestamp-less reply",
      }),
    ).toBe(true);
    expect(
      await hasSignalSelfReplyEcho({
        accountId: "default",
        messageId: String(sentAt + 1_000),
        timestamp: sentAt + 1_000,
        text: "timestamp-less reply",
        includeTextWithPrimary: true,
      }),
    ).toBe(true);

    vi.setSystemTime(new Date("2026-01-01T00:03:00.000Z"));

    expect(
      await hasSignalSelfReplyEcho({
        accountId: "default",
        messageId: String(sentAt + 60_000),
        timestamp: sentAt + 60_000,
        text: "timestamp-less reply",
      }),
    ).toBe(false);
    expect(
      await hasSignalSelfReplyEcho({
        accountId: "default",
        messageId: "1000",
        timestamp: 1000,
      }),
    ).toBe(true);
  });

  it("uses specific attachment metadata for media echo text", () => {
    expect(resolveSignalSelfReplyMediaEchoText({ contentType: " Image/PNG ", size: 4321 })).toBe(
      "<media:image:image/png:4321>",
    );
    expect(resolveSignalSelfReplyMediaEchoText({ contentType: "image/png" })).toBeUndefined();
    expect(resolveSignalSelfReplyMediaEchoText({ size: 4321 })).toBeUndefined();
  });

  it("namespaces echoes by Signal account identity", async () => {
    await rememberSignalSelfReplyEcho({
      accountId: "default",
      accountIdentity: "+15550001111",
      messageId: "1000",
      timestamp: 1000,
    });

    expect(
      await hasSignalSelfReplyEcho({
        accountId: "default",
        accountIdentity: "+15550002222",
        messageId: "1000",
        timestamp: 1000,
      }),
    ).toBe(false);
    expect(
      await hasSignalSelfReplyEcho({
        accountId: "default",
        accountIdentity: "+15550001111",
        messageId: "1000",
        timestamp: 1000,
      }),
    ).toBe(true);
  });

  it("matches compact and hyphenated UUID account identities", async () => {
    await rememberSignalSelfReplyEcho({
      accountId: "default",
      accountIdentity: "123e4567-e89b-12d3-a456-426614174000",
      messageId: "1000",
      timestamp: 1000,
    });

    expect(
      await hasSignalSelfReplyEcho({
        accountId: "default",
        accountIdentity: "123e4567e89b12d3a456426614174000",
        messageId: "1000",
        timestamp: 1000,
      }),
    ).toBe(true);
  });

  it("keeps in-memory echo caps per Signal account", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    await rememberSignalSelfReplyEcho({
      accountId: "quiet",
      messageId: "quiet-1",
      timestamp: 1,
    });

    for (let index = 0; index < 300; index += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, 1 + index)));
      await rememberSignalSelfReplyEcho({
        accountId: "busy",
        messageId: `busy-${index}`,
        timestamp: index + 1,
      });
    }

    expect(
      await hasSignalSelfReplyEcho({
        accountId: "quiet",
        messageId: "quiet-1",
        timestamp: 1,
      }),
    ).toBe(true);
  });
});
