import type { Message, Space } from "spectrum-ts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let runtime: Awaited<typeof import("./channel.runtime.js")>;

function message(params: {
  id: string;
  content?: unknown;
  timestamp?: Date;
  extra?: Record<string, unknown>;
}): Message {
  return {
    id: params.id,
    timestamp: params.timestamp ?? new Date(0),
    sender: { id: "sender" },
    content: params.content ?? { type: "text", text: "hello" },
    ...(params.extra ?? {}),
  } as unknown as Message;
}

function space(id = "space"): Space {
  return { id } as unknown as Space;
}

beforeAll(async () => {
  vi.useFakeTimers();
  runtime = await import("./channel.runtime.js");
});

afterAll(() => {
  vi.useRealTimers();
});

describe("resolveSpectrumInboundThreadReplyToId", () => {
  it("uses Spectrum reply content targets as iMessage thread parents", () => {
    expect(
      runtime.resolveSpectrumInboundThreadReplyToId(
        message({
          id: "reply-message",
          content: {
            type: "reply",
            target: { id: "parent-message" },
            reply: { type: "text", text: "thread reply" },
          },
        }),
      ),
    ).toBe("parent-message");
  });

  it("ignores generic parentId metadata for normal main-chat messages", () => {
    expect(
      runtime.resolveSpectrumInboundThreadReplyToId(
        message({
          id: "normal-message",
          extra: { parentId: "multipart-or-provider-parent" },
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps explicit reply metadata", () => {
    expect(
      runtime.resolveSpectrumInboundThreadReplyToId(
        message({
          id: "explicit-message",
          extra: { replyToId: "explicit-parent" },
        }),
      ),
    ).toBe("explicit-parent");
  });
});

describe("resolveSpectrumPayloadEffectName", () => {
  it("accepts documented effect aliases from provider payloads", () => {
    expect(runtime.resolveSpectrumPayloadEffectName({ effect_id: "happy-birthday" })).toBe(
      "celebration",
    );
    expect(runtime.resolveSpectrumPayloadEffectName({ imessage_effect: "invisible ink" })).toBe(
      "invisible",
    );
  });
});

describe("resolveSpectrumDeliveryReplyToId", () => {
  it("uses inbound thread context unless the outbound payload suppresses it", () => {
    expect(
      runtime.resolveSpectrumDeliveryReplyToId({
        inboundThreadReplyToId: "thread-parent",
      }),
    ).toBe("thread-parent");

    expect(
      runtime.resolveSpectrumDeliveryReplyToId({
        payload: { replyToId: null },
        inboundThreadReplyToId: "thread-parent",
      }),
    ).toBeUndefined();
  });
});

describe("selectSpectrumCatchupEntries", () => {
  it("seeds an empty cursor without replaying historical messages", () => {
    const older = message({ id: "older", timestamp: new Date("2026-01-01T00:00:00Z") });
    const newer = message({ id: "newer", timestamp: new Date("2026-01-01T00:01:00Z") });

    const selected = runtime.selectSpectrumCatchupEntries({
      cursor: null,
      entries: [
        { space: space(), message: newer },
        { space: space(), message: older },
      ],
    });

    expect(selected.replay).toEqual([]);
    expect(selected.seed).toEqual({
      messageId: "newer",
      messageAt: newer.timestamp?.getTime(),
    });
  });

  it("replays only messages after the persisted cursor", () => {
    const first = message({ id: "first", timestamp: new Date("2026-01-01T00:00:00Z") });
    const second = message({ id: "second", timestamp: new Date("2026-01-01T00:01:00Z") });

    const selected = runtime.selectSpectrumCatchupEntries({
      cursor: {
        lastProcessedMessageId: "first",
        updatedAt: Date.now(),
      },
      entries: [
        { space: space(), message: second },
        { space: space(), message: first },
      ],
    });

    expect(selected.replay.map((entry) => entry.message.id)).toEqual(["second"]);
    expect(selected.seed).toBeUndefined();
  });
});
