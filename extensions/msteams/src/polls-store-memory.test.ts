import { describe, expect, it } from "vitest";
import { createMSTeamsPollStoreMemory } from "./polls-store-memory.js";

describe("createMSTeamsPollStoreMemory", () => {
  it("creates polls, reads them back, and records normalized votes", async () => {
    const store = createMSTeamsPollStoreMemory([
      {
        id: "poll-1",
        question: "Pick one",
        options: ["A", "B"],
        maxSelections: 1,
        votes: {},
        createdAt: "2026-03-22T00:00:00.000Z",
        updatedAt: "2026-03-22T00:00:00.000Z",
      },
    ]);

    await expect(store.getPoll("poll-1")).resolves.toEqual(
      expect.objectContaining({
        id: "poll-1",
        question: "Pick one",
      }),
    );

    const originalUpdatedAt = "2026-03-22T00:00:00.000Z";
    await store.getPoll("poll-1");
    const result = await store.recordVote({
      pollId: "poll-1",
      voterId: "user-1",
      selections: ["1", "0", "missing"],
    });

    expect(result?.votes["user-1"]).toEqual(["1"]);
    expect(result?.updatedAt).not.toBe(originalUpdatedAt);

    await store.createPoll({
      id: "poll-2",
      question: "Pick many",
      options: ["X", "Y"],
      maxSelections: 2,
      votes: {},
      createdAt: "2026-03-22T00:00:00.000Z",
      updatedAt: "2026-03-22T00:00:00.000Z",
    });

    await expect(
      store.recordVote({
        pollId: "poll-2",
        voterId: "user-2",
        selections: ["1", "0", "1"],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "poll-2",
        votes: {
          "user-2": ["1", "0"],
        },
      }),
    );

    await expect(store.recordVote({ pollId: "missing", voterId: "nobody", selections: ["x"] })).resolves.toBeNull();
  });
});
