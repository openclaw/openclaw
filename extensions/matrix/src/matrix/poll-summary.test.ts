import { describe, expect, it, vi } from "vitest";
import { fetchMatrixPollSnapshot } from "./poll-summary.js";
import type { MatrixClient, MatrixRawEvent } from "./sdk.js";

function createPollStartEvent(namespace = "m.poll"): MatrixRawEvent {
  const type = `${namespace}.start`;
  return {
    event_id: "$poll",
    sender: "@alice:example.org",
    type,
    origin_server_ts: 1,
    content: {
      [type]: {
        question: { "m.text": "Lunch?" },
        answers: [
          { id: "a", "m.text": "Pizza" },
          { id: "a ", "m.text": "Sushi" },
        ],
      },
    },
  } as MatrixRawEvent;
}

describe("Matrix poll snapshot pagination", () => {
  it.each([
    { name: "a repeated cursor", cursors: ["stuck", "stuck"] },
    { name: "a cursor cycle", cursors: ["first", "second", "first"] },
  ])("fails visibly on $name", async ({ cursors }) => {
    let calls = 0;
    const getRelations = vi.fn(async () => {
      const nextBatch = cursors[calls++];
      if (nextBatch === undefined) {
        throw new Error("test stopped unbounded Matrix poll pagination");
      }
      return { events: [], nextBatch, prevBatch: null };
    });

    await expect(
      fetchMatrixPollSnapshot(
        { getRelations } as unknown as MatrixClient,
        "!room:example.org",
        createPollStartEvent(),
      ),
    ).rejects.toThrow("Matrix poll pagination returned a repeated cursor");
    expect(getRelations).toHaveBeenCalledTimes(cursors.length);
  });

  it.each(["m.poll", "org.matrix.msc3381.poll"])("tallies exact %s IDs", async (namespace) => {
    const responseType = `${namespace}.response`;
    const getRelations = vi
      .fn()
      .mockResolvedValueOnce({ events: [], nextBatch: "next-page", prevBatch: null })
      .mockResolvedValueOnce({
        events: [
          {
            event_id: "$vote",
            sender: "@bob:example.org",
            type: responseType,
            origin_server_ts: 2,
            content: {
              [responseType]: { answers: ["a "] },
              "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
            },
          },
        ],
        nextBatch: null,
        prevBatch: null,
      });

    const snapshot = await fetchMatrixPollSnapshot(
      { getRelations } as unknown as MatrixClient,
      "!room:example.org",
      createPollStartEvent(namespace),
    );

    expect(getRelations).toHaveBeenNthCalledWith(
      2,
      "!room:example.org",
      "$poll",
      "m.reference",
      undefined,
      { from: "next-page" },
    );
    expect(snapshot?.text).toContain("1. Pizza (0 votes)\n2. Sushi (1 vote)");
    expect(snapshot?.text).toContain("Total voters: 1");
  });
});
