import { describe, expect, it, vi } from "vitest";
import { createMatrixEventContextResolver } from "./event-context.js";
import {
  bundledReplacementContentCases,
  createBundledReplacementEvent,
  createPollStartEvent,
  invalidBundledReplacementCases,
} from "./test-events.js";
import type { MatrixRawEvent } from "./types.js";

function message(
  body: string,
  sender = "@alice:example.org",
  event_id = "$original",
  msgtype = "m.text",
): MatrixRawEvent {
  return {
    event_id,
    sender,
    type: "m.room.message",
    origin_server_ts: 1,
    content: { msgtype, body },
  };
}

function resolver(
  getEvent: ReturnType<typeof vi.fn>,
  getMemberDisplayName: Parameters<
    typeof createMatrixEventContextResolver
  >[0]["getMemberDisplayName"] = vi.fn(async () => "Alice"),
) {
  const resolve = createMatrixEventContextResolver({
    kind: "reply",
    client: { getEvent } as never,
    getMemberDisplayName,
    logVerboseMessage: () => {},
  });
  return (eventId = "$original") => resolve({ roomId: "!room:example.org", eventId });
}

async function resolveReplyBody(event: MatrixRawEvent): Promise<string | undefined> {
  return (await resolver(vi.fn(async () => event))(event.event_id ?? "$event")).summary;
}

describe("matrix reply context", () => {
  it.each(bundledReplacementContentCases.filter(({ name }) => name !== "text"))(
    "uses the latest bundled $name when quoting an edited message",
    async ({ options, expected }) => {
      expect(await resolveReplyBody(createBundledReplacementEvent("$original", options))).toBe(
        expected,
      );
    },
  );

  it.each(
    invalidBundledReplacementCases.filter(({ name }) =>
      [
        "another sender",
        "another target",
        "a state-event original",
        "array replacement content",
        "an object-backed redacted replacement",
      ].includes(name),
    ),
  )("does not quote a bundled replacement from $name", async ({ options }) => {
    expect(await resolveReplyBody(createBundledReplacementEvent("$original", options))).toBe(
      "original text",
    );
  });

  it("does not revive a bundled replacement from a redacted original", async () => {
    expect(
      await resolveReplyBody(
        createBundledReplacementEvent("$original", { content: {}, redacted: true }),
      ),
    ).toBeUndefined();
  });

  it("truncates on a code-point boundary without orphaning a surrogate half", async () => {
    // The truncation boundary bisects this surrogate pair.
    const body = `${"a".repeat(496)}😀bcd`;
    expect(body.length).toBe(501);
    const result = await resolveReplyBody(message(body));
    expect(result).toBe(`${"a".repeat(496)}...`);
    expect(result).not.toContain("\uD83D");
  });

  it("handles media-only reply events", async () => {
    expect(await resolveReplyBody(message("photo.jpg", undefined, undefined, "m.image"))).toBe(
      "[matrix image attachment]",
    );
  });

  it("summarizes poll start events from poll content", async () => {
    expect(await resolveReplyBody(createPollStartEvent("$poll"))).toBe(
      "[Poll]\nLunch?\n\n1. Pizza\n2. Sushi",
    );
  });

  it("does not cache fetch failures so retries can succeed", async () => {
    const getEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(message("Recovered message", "@bob:example.org"));
    const resolveReplyContext = resolver(
      getEvent,
      vi.fn(async () => "Bob"),
    );
    await expect(resolveReplyContext()).resolves.toStrictEqual({});
    await expect(resolveReplyContext()).resolves.toEqual({
      summary: "Recovered message",
      senderLabel: "Bob",
      senderId: "@bob:example.org",
    });

    expect(getEvent).toHaveBeenCalledTimes(2);
  });

  it("falls back to senderId when display name resolution fails", async () => {
    const resolveReplyContext = resolver(
      vi.fn(async () => message("Hello", "@charlie:example.org")),
      vi.fn().mockRejectedValueOnce(new Error("unknown member")),
    );
    await expect(resolveReplyContext()).resolves.toEqual({
      summary: "Hello",
      senderLabel: "@charlie:example.org",
      senderId: "@charlie:example.org",
    });
  });

  it("retains recently accessed reply contexts when the cache exceeds 256 entries", async () => {
    const getEvent = vi.fn(async (_roomId: string, eventId: string) =>
      message(`msg-${eventId}`, undefined, eventId),
    );
    const getMemberDisplayName = vi
      .fn()
      .mockImplementation((_r: string, userId: string) => Promise.resolve(userId));
    const resolveReplyContext = resolver(getEvent, getMemberDisplayName);
    const oldest = await resolveReplyContext("$event-0");
    const nextOldest = await resolveReplyContext("$event-1");
    for (let i = 2; i < 256; i += 1) {
      await resolveReplyContext(`$event-${i}`);
    }
    expect(await resolveReplyContext("$event-0")).toBe(oldest);
    expect(getEvent).toHaveBeenCalledTimes(256);

    await resolveReplyContext("$event-256");

    // Check the survivor before refetching the victim triggers another eviction.
    expect(await resolveReplyContext("$event-0")).toBe(oldest);
    expect(getEvent).toHaveBeenCalledTimes(257);
    expect(await resolveReplyContext("$event-1")).not.toBe(nextOldest);
    expect(getEvent).toHaveBeenCalledTimes(258);
    for (let i = 0; i <= 256; i += 1) {
      expect(getEvent.mock.calls.filter(([, eventId]) => eventId === `$event-${i}`)).toHaveLength(
        i === 1 ? 2 : 1,
      );
    }
  });
});
