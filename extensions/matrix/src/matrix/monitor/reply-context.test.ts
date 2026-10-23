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
  kind: "reply" | "thread" = "reply",
) {
  const resolve = createMatrixEventContextResolver({
    kind,
    client: { getEvent } as never,
    getMemberDisplayName,
    logVerboseMessage: () => {},
  });
  return (eventId = "$original") => resolve({ roomId: "!room:example.org", eventId });
}

async function resolveReplyBody(event: MatrixRawEvent, kind: "reply" | "thread" = "reply") {
  const resolve = resolver(vi.fn().mockResolvedValue(event), undefined, kind);
  return (await resolve(event.event_id ?? "$event")).summary;
}

describe("matrix reply and thread context", () => {
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

  it("uses the latest bundled text when summarizing an edited thread root", async () => {
    expect(await resolveReplyBody(createBundledReplacementEvent("$root"), "thread")).toBe(
      "edited text",
    );
  });

  it.each(["reply", "thread"] as const)(
    "does not revive a redacted %s replacement",
    async (kind) => {
      expect(
        await resolveReplyBody(
          createBundledReplacementEvent("$original", { content: {}, redacted: true }),
          kind,
        ),
      ).toBe(kind === "reply" ? undefined : "Matrix m.room.message event");
    },
  );

  it.each(["reply", "thread"] as const)("truncates %s on a code-point boundary", async (kind) => {
    // The truncation boundary bisects this surrogate pair.
    const body = `${"a".repeat(496)}😀bcd`;
    expect(body.length).toBe(501);
    const result = await resolveReplyBody(message(body), kind);
    expect(result).toBe(`${"a".repeat(496)}...`);
    expect(result).not.toContain("\uD83D");
  });

  it.each(["reply", "thread"] as const)("handles media-only %s events", async (kind) => {
    expect(
      await resolveReplyBody(message("photo.jpg", undefined, undefined, "m.image"), kind),
    ).toBe("[matrix image attachment]");
  });

  it.each(["reply", "thread"] as const)("summarizes %s polls from poll content", async (kind) => {
    expect(await resolveReplyBody(createPollStartEvent("$poll"), kind)).toBe(
      "[Poll]\nLunch?\n\n1. Pizza\n2. Sushi",
    );
  });

  it.each(["reply", "thread"] as const)("does not cache %s fetch failures", async (kind) => {
    const getEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(message("Recovered message", "@bob:example.org"));
    const getMemberDisplayName = vi.fn(async () => "Alice");
    const resolveReplyContext = resolver(getEvent, getMemberDisplayName, kind);
    await expect(resolveReplyContext()).resolves.toStrictEqual(
      kind === "reply" ? {} : { threadStarterBody: "Matrix thread root $original" },
    );
    await expect(resolveReplyContext()).resolves.toEqual({
      summary: "Recovered message",
      senderLabel: "Alice",
      senderId: "@bob:example.org",
      ...(kind === "thread"
        ? { threadStarterBody: "Matrix thread root $original from Alice:\nRecovered message" }
        : {}),
    });

    expect(getEvent).toHaveBeenCalledTimes(2);
    expect(getMemberDisplayName).toHaveBeenCalledTimes(1);
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

  it.each(["reply", "thread"] as const)(
    "evicts %s contexts using its cache policy",
    async (kind) => {
      const getEvent = vi.fn(async (_roomId: string, eventId: string) =>
        message(`msg-${eventId}`, undefined, eventId),
      );
      const getMemberDisplayName = vi.fn(async (_r: string, userId: string) => userId);
      const resolveReplyContext = resolver(getEvent, getMemberDisplayName, kind);
      const oldest = await resolveReplyContext("$event-0");
      const nextOldest = await resolveReplyContext("$event-1");
      for (let i = 2; i < 256; i += 1) {
        await resolveReplyContext(`$event-${i}`);
      }
      expect(await resolveReplyContext("$event-0")).toBe(oldest);
      expect(getEvent).toHaveBeenCalledTimes(256);

      await resolveReplyContext("$event-256");

      // Check the survivor before refetching the victim triggers another eviction.
      const survivor = kind === "reply" ? 0 : 1;
      const victim = 1 - survivor;
      expect(await resolveReplyContext(`$event-${survivor}`)).toBe(
        kind === "reply" ? oldest : nextOldest,
      );
      expect(getEvent).toHaveBeenCalledTimes(257);
      expect(await resolveReplyContext(`$event-${victim}`)).not.toBe(
        kind === "reply" ? nextOldest : oldest,
      );
      expect(getEvent).toHaveBeenCalledTimes(258);
      for (let i = 0; i <= 256; i += 1) {
        expect(getEvent.mock.calls.filter(([, eventId]) => eventId === `$event-${i}`)).toHaveLength(
          i === victim ? 2 : 1,
        );
      }
    },
  );
});
