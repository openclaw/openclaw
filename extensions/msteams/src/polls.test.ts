// Msteams tests cover polls plugin behavior.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMSTeamsPollCard,
  createMSTeamsPollStoreState,
  extractMSTeamsPollVote,
  type MSTeamsPollStore,
} from "./polls.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);

type Poll = Parameters<MSTeamsPollStore["createPoll"]>[0];

function poll(overrides: Partial<Poll>): Poll {
  return {
    id: "poll-1",
    question: "Pick one",
    options: ["A", "B"],
    maxSelections: 1,
    createdAt: new Date().toISOString(),
    votes: {},
    ...overrides,
  };
}

describe("msteams polls", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("builds poll cards with fallback text", () => {
    const card = buildMSTeamsPollCard({
      question: "Lunch?",
      options: ["Pizza", "Sushi"],
    });

    expect(card.pollId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(card.fallbackText).toBe("Poll: Lunch?\n1. Pizza\n2. Sushi");
  });

  it("extracts poll votes from activity values", () => {
    const vote = extractMSTeamsPollVote({
      value: {
        openclawPollId: "poll-1",
        choices: "0,1",
      },
    });

    expect(vote).toEqual({
      pollId: "poll-1",
      selections: ["0", "1"],
    });
  });

  it("stores and records poll votes", async () => {
    const home = tempDirs.make("openclaw-msteams-polls-");
    const store = createMSTeamsPollStoreState({ homedir: () => home });
    await store.createPoll(poll({ id: "poll-2" }));
    await store.recordVote({
      pollId: "poll-2",
      voterId: "user-1",
      selections: ["0", "1"],
    });
    const stored = await store.getPoll("poll-2");
    if (!stored) {
      throw new Error("expected stored poll after recordVote");
    }
    expect(stored.votes["user-1"]).toEqual(["0"]);
  });

  it("deduplicates selections before enforcing maxSelections", async () => {
    const home = tempDirs.make("openclaw-msteams-polls-");
    const store = createMSTeamsPollStoreState({ homedir: () => home });
    await store.createPoll(poll({ id: "poll-dedupe", options: ["A", "B", "C"], maxSelections: 2 }));
    await store.recordVote({
      pollId: "poll-dedupe",
      voterId: "user-1",
      selections: ["0", "0", "1"],
    });
    const stored = await store.getPoll("poll-dedupe");
    if (!stored) {
      throw new Error("expected stored poll after recordVote");
    }
    expect(stored.votes["user-1"]).toEqual(["0", "1"]);
  });
});

describe("state poll store", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("ignores legacy JSON polls at runtime", async () => {
    const stateDir = tempDirs.make("openclaw-msteams-polls-");
    const filePath = path.join(stateDir, "msteams-polls.json");
    await fs.promises.writeFile(
      filePath,
      `${JSON.stringify({
        version: 1,
        polls: {
          "poll-legacy": {
            id: "poll-legacy",
            question: "Legacy?",
            options: ["A", "B"],
            maxSelections: 1,
            createdAt: new Date().toISOString(),
            votes: {},
          },
        },
      })}\n`,
    );

    const store = createMSTeamsPollStoreState({ stateDir });
    await expect(store.getPoll("poll-legacy")).resolves.toBeNull();
    await fs.promises.access(filePath);

    await store.createPoll(poll({ id: "poll-new" }));
    await expect(store.getPoll("poll-new")).resolves.toMatchObject({ id: "poll-new" });
    await fs.promises.access(path.join(stateDir, "state", "openclaw.sqlite"));
  });

  it("hashes external poll ids before using plugin-state keys", async () => {
    const stateDir = tempDirs.make("openclaw-msteams-polls-");
    const store = createMSTeamsPollStoreState({ stateDir });
    const longPollId = `poll-${"x".repeat(900)}`;

    await store.createPoll(poll({ id: longPollId }));

    await expect(store.getPoll(longPollId)).resolves.toMatchObject({ id: longPollId });
    await expect(
      store.recordVote({
        pollId: `missing-${"y".repeat(900)}`,
        voterId: "user-1",
        selections: ["0"],
      }),
    ).resolves.toBeNull();
  });

  it("serializes concurrent votes for the same poll", async () => {
    const stateDir = tempDirs.make("openclaw-msteams-polls-");
    const store = createMSTeamsPollStoreState({ stateDir });
    await store.createPoll(poll({ id: "poll-race" }));

    await Promise.all([
      store.recordVote({ pollId: "poll-race", voterId: "user-a", selections: ["0"] }),
      store.recordVote({ pollId: "poll-race", voterId: "user-b", selections: ["1"] }),
    ]);

    await expect(store.getPoll("poll-race")).resolves.toMatchObject({
      votes: {
        "user-a": ["0"],
        "user-b": ["1"],
      },
    });
  });

  it.each([
    { selections: ["0", "1x"], expected: ["0"] },
    { selections: ["+0", "0x1", "1"], expected: ["0", "1"] },
  ])("accepts only strict decimal poll selections", async ({ selections, expected }) => {
    const stateDir = tempDirs.make("openclaw-msteams-polls-");
    const store = createMSTeamsPollStoreState({ stateDir });
    await store.createPoll(poll({ id: "poll-strict-selections", maxSelections: 2 }));

    await expect(
      store.recordVote({
        pollId: "poll-strict-selections",
        voterId: "user-1",
        selections,
      }),
    ).resolves.toMatchObject({ votes: { "user-1": expected } });
  });

  it("keeps large vote maps split across bounded rows", async () => {
    const stateDir = tempDirs.make("openclaw-msteams-polls-");
    const store = createMSTeamsPollStoreState({ stateDir });
    const votes = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `user-${String(index).padStart(4, "0")}-${"x".repeat(160)}`,
        ["0"],
      ]),
    );

    await store.createPoll(poll({ id: "poll-large", votes }));
    await store.recordVote({ pollId: "poll-large", voterId: "user-new", selections: ["1"] });

    const stored = await store.getPoll("poll-large");
    expect(Object.keys(stored?.votes ?? {})).toHaveLength(501);
    expect(stored?.votes["user-new"]).toEqual(["1"]);
  });

  it.each([
    { existing: 998, expired: [], removed: [], scans: 1 },
    {
      existing: 1003,
      expired: ["poll-expired-a", "poll-expired-b"],
      removed: [
        "poll-old",
        "poll-existing-0",
        "poll-existing-1",
        "poll-existing-2",
        "poll-existing-3",
      ],
      scans: 2,
    },
  ])(
    "bounds vote bucket scans while pruning $existing existing polls",
    async ({ existing, expired, removed, scans }) => {
      const stateDir = tempDirs.make("openclaw-msteams-polls-");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const metadataStore = createPluginStateKeyedStoreForTests<
        Omit<Parameters<MSTeamsPollStore["createPoll"]>[0], "votes">
      >("msteams", {
        namespace: "polls",
        maxEntries: 2000,
        env,
      });
      const voteBucketStore = createPluginStateKeyedStoreForTests<{
        pollId: string;
        bucket: string;
        votes: Record<string, string[]>;
        updatedAt: string;
      }>("msteams", {
        namespace: "poll-vote-buckets",
        maxEntries: 32_032,
        env,
      });
      const pollStateKey = (pollId: string) =>
        crypto.createHash("sha256").update(pollId).digest("hex");
      const voteBucket = (pollId: string, voterId: string) => {
        const hash = crypto
          .createHash("sha256")
          .update(pollId)
          .update("\0")
          .update(voterId)
          .digest("hex");
        return String(Number.parseInt(hash.slice(0, 8), 16) % 32).padStart(4, "0");
      };
      const baseMs = Date.now() - 60_000;
      const oldPollId = "poll-old";

      for (const [index, id] of [
        oldPollId,
        ...Array.from({ length: existing }, (_, entryIndex) => `poll-existing-${entryIndex}`),
      ].entries()) {
        await metadataStore.register(pollStateKey(id), {
          id,
          question: "Pick",
          options: ["A", "B"],
          maxSelections: 1,
          createdAt: new Date(baseMs + index).toISOString(),
        });
      }
      for (const id of expired) {
        await metadataStore.register(pollStateKey(id), {
          id,
          question: "Expired",
          options: ["A", "B"],
          maxSelections: 1,
          createdAt: new Date(baseMs - 31 * 24 * 60 * 60 * 1000).toISOString(),
        });
        await voteBucketStore.register(`${pollStateKey(id)}:0000`, {
          pollId: id,
          bucket: "0000",
          votes: { "user-expired": ["0"] },
          updatedAt: new Date(baseMs).toISOString(),
        });
      }
      const oldBucket = voteBucket(oldPollId, "user-old");
      await voteBucketStore.register(`${pollStateKey(oldPollId)}:${oldBucket}`, {
        pollId: oldPollId,
        bucket: oldBucket,
        votes: { "user-old": ["0"] },
        updatedAt: new Date(baseMs).toISOString(),
      });

      let bucketScans = 0;
      // oxlint-disable-next-line typescript/unbound-method -- Preserve the native statement receiver below.
      const iterate = StatementSync.prototype.iterate;
      const iterateSpy = vi.spyOn(StatementSync.prototype, "iterate").mockImplementation(function (
        this: StatementSync,
        ...bindings
      ) {
        if (
          /^select\b.*\bfrom "plugin_state_entries"/iu.test(this.sourceSQL) &&
          this.sourceSQL.includes('"value_json"') &&
          !this.sourceSQL.includes('"entry_key" =') &&
          bindings.includes("poll-vote-buckets")
        ) {
          bucketScans += 1;
        }
        return iterate.call(this, ...bindings);
      });
      const store = createMSTeamsPollStoreState({ env });
      try {
        await store.createPoll({
          id: "poll-new",
          question: "New?",
          options: ["A", "B"],
          maxSelections: 1,
          createdAt: new Date(baseMs + 2_000_000).toISOString(),
          votes: { "user-new": ["1"] },
        });
      } finally {
        iterateSpy.mockRestore();
      }
      expect(bucketScans).toBeLessThanOrEqual(scans);
      expect(await metadataStore.entries()).toHaveLength(1000);
      for (const id of [...expired, ...removed]) {
        await expect(store.getPoll(id)).resolves.toBeNull();
      }
      const buckets = await voteBucketStore.entries();
      expect(buckets.map((row) => row.value.pollId)).toEqual(
        removed.length ? ["poll-new"] : [oldPollId, "poll-new"],
      );
    },
  );
  it.each(["delete", "null value", "invalid JSON"])(
    "preserves partial cleanup before a bucket %s failure",
    async (failure) => {
      const stateDir = tempDirs.make("openclaw-msteams-polls-");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const metadata = createPluginStateKeyedStoreForTests<unknown>("msteams", {
        namespace: "polls",
        maxEntries: 2000,
        env,
      });
      const buckets = createPluginStateKeyedStoreForTests<unknown>("msteams", {
        namespace: "poll-vote-buckets",
        maxEntries: 32_032,
        env,
      });
      const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      for (const id of ["expired-a", "expired-b"]) {
        await metadata.register(id, { id, createdAt: expiredAt });
      }
      for (const key of ["first", "failing", "later"]) {
        await buckets.register(key, {
          pollId: key === "later" ? "expired-b" : "expired-a",
          bucket: key,
          votes: { voter: ["0"] },
          updatedAt: expiredAt,
        });
      }
      const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
      try {
        database.exec(`
          UPDATE plugin_state_entries SET created_at = CASE entry_key
            WHEN 'first' THEN 1 WHEN 'failing' THEN 2 ELSE 3 END
          WHERE plugin_id = 'msteams' AND namespace = 'poll-vote-buckets';
        `);
        // Inject the failure after createPoll's initial vote replacement read.
        database.exec(
          failure === "delete"
            ? `
          CREATE TRIGGER fail_bucket_delete BEFORE DELETE ON plugin_state_entries
          WHEN OLD.plugin_id = 'msteams' AND OLD.namespace = 'poll-vote-buckets'
            AND OLD.entry_key = 'failing'
          BEGIN SELECT RAISE(ABORT, 'bucket deletion failed'); END;
        `
            : `
          CREATE TRIGGER corrupt_bucket AFTER DELETE ON plugin_state_entries
          WHEN OLD.plugin_id = 'msteams' AND OLD.namespace = 'polls'
            AND OLD.entry_key = 'expired-a'
          BEGIN UPDATE plugin_state_entries SET value_json = '${failure === "null value" ? "null" : "{"}'
            WHERE plugin_id = 'msteams' AND namespace = 'poll-vote-buckets'
              AND entry_key = 'failing'; END;
        `,
        );
        const store = createMSTeamsPollStoreState({ env });
        await expect(
          store.createPoll({
            id: "new",
            question: "Pick",
            options: ["A", "B"],
            maxSelections: 1,
            createdAt: new Date().toISOString(),
            votes: {},
          }),
        ).rejects.toThrow();
        const remaining = database
          .prepare(
            "SELECT namespace, entry_key FROM plugin_state_entries WHERE plugin_id = 'msteams' ORDER BY namespace, entry_key",
          )
          .all();
        expect(remaining).toEqual([
          { namespace: "poll-vote-buckets", entry_key: "failing" },
          ...(failure === "invalid JSON"
            ? [{ namespace: "poll-vote-buckets", entry_key: "first" }]
            : []),
          { namespace: "poll-vote-buckets", entry_key: "later" },
          {
            namespace: "polls",
            entry_key: crypto.createHash("sha256").update("new").digest("hex"),
          },
          { namespace: "polls", entry_key: "expired-b" },
        ]);
      } finally {
        database.close();
      }
    },
  );
});
