import { describe, expect, it, vi } from "vitest";
import { createMatrixEventContextResolver } from "./event-context.js";
import { createBundledReplacementEvent, createPollStartEvent } from "./test-events.js";
import type { MatrixRawEvent } from "./types.js";

function makeEvent(content: MatrixRawEvent["content"], eventId = "$root"): MatrixRawEvent {
  return {
    event_id: eventId,
    sender: "@alice:example.org",
    type: "m.room.message",
    origin_server_ts: 100,
    content,
  };
}

function createThreadResolver(
  getEvent: (roomId: string, eventId: string) => Promise<MatrixRawEvent>,
  getMemberDisplayName = vi.fn(async () => "Alice"),
) {
  const resolve = createMatrixEventContextResolver({
    kind: "thread",
    client: { getEvent } as never,
    getMemberDisplayName,
    logVerboseMessage: () => {},
  });
  return (eventId = "$root") => resolve({ roomId: "!room:example.org", eventId });
}

async function resolveThreadSummary(event: MatrixRawEvent): Promise<string | undefined> {
  return (await createThreadResolver(async () => event)(event.event_id ?? "$root")).summary;
}

describe("matrix thread context", () => {
  it("uses the latest bundled text when summarizing an edited thread root", async () => {
    expect(await resolveThreadSummary(createBundledReplacementEvent("$root"))).toBe("edited text");
  });

  it("does not revive a bundled replacement from a redacted thread root", async () => {
    expect(
      await resolveThreadSummary(
        createBundledReplacementEvent("$root", { content: {}, redacted: true }),
      ),
    ).toBe("Matrix m.room.message event");
  });

  it("truncates long thread starter bodies on code-point boundaries", async () => {
    const summary = await resolveThreadSummary(
      makeEvent({
        msgtype: "m.text",
        // slice(0, 497) would split this emoji's surrogate pair.
        body: `${"a".repeat(496)}\u{1F600}bcd`,
      }),
    );
    expect(summary).toBe(`${"a".repeat(496)}...`);
    expect(summary && /[\uD800-\uDFFF]/.test(summary)).toBe(false);
  });

  it("marks media-only thread starter events instead of returning bare filenames", async () => {
    expect(await resolveThreadSummary(makeEvent({ msgtype: "m.image", body: "photo.jpg" }))).toBe(
      "[matrix image attachment]",
    );
  });

  it("evicts the oldest thread context despite a cache hit when exceeding 256 entries", async () => {
    const getEvent = vi.fn(async (_roomId: string, eventId: string) =>
      makeEvent({ msgtype: "m.text", body: `msg-${eventId}` }, eventId),
    );
    const resolve = createThreadResolver(getEvent);
    const oldest = await resolve("$event-0");
    const nextOldest = await resolve("$event-1");
    for (let i = 2; i < 256; i += 1) {
      await resolve(`$event-${i}`);
    }
    expect(await resolve("$event-0")).toBe(oldest);
    expect(getEvent).toHaveBeenCalledTimes(256);

    await resolve("$event-256");

    // Check the survivor before refetching the victim triggers another eviction.
    expect(await resolve("$event-1")).toBe(nextOldest);
    expect(getEvent).toHaveBeenCalledTimes(257);
    expect(await resolve("$event-0")).not.toBe(oldest);
    expect(getEvent).toHaveBeenCalledTimes(258);
    for (let i = 0; i <= 256; i += 1) {
      expect(getEvent.mock.calls.filter(([, eventId]) => eventId === `$event-${i}`)).toHaveLength(
        i === 0 ? 2 : 1,
      );
    }
  });

  it("does not cache thread starter fetch failures", async () => {
    const getEvent = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(makeEvent({ msgtype: "m.text", body: "Recovered topic" }));
    const getMemberDisplayName = vi.fn(async () => "Alice");
    const resolve = createThreadResolver(getEvent, getMemberDisplayName);

    await expect(resolve()).resolves.toEqual({ threadStarterBody: "Matrix thread root $root" });

    await expect(resolve()).resolves.toEqual({
      threadStarterBody: "Matrix thread root $root from Alice:\nRecovered topic",
      senderId: "@alice:example.org",
      senderLabel: "Alice",
      summary: "Recovered topic",
    });

    expect(getEvent).toHaveBeenCalledTimes(2);
    expect(getMemberDisplayName).toHaveBeenCalledTimes(1);
  });

  it("summarizes poll start thread roots from poll content", async () => {
    expect(await resolveThreadSummary(createPollStartEvent("$root"))).toBe(
      "[Poll]\nLunch?\n\n1. Pizza\n2. Sushi",
    );
  });
});
