import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMSTeamsPollCard,
  createMSTeamsPollStoreState,
  extractMSTeamsPollVote,
  type MSTeamsPollStore,
} from "./polls.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { resolveMSTeamsAccountStateNamespace } from "./sqlite-state.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);

afterEach(() => vi.unstubAllEnvs());

type Poll = Parameters<MSTeamsPollStore["createPoll"]>[0];
const pollStateKey = (id: string) => crypto.createHash("sha256").update(id).digest("hex");

function pluginStore<T>(namespace: string, maxEntries: number, env: NodeJS.ProcessEnv) {
  return createPluginStateKeyedStoreForTests<T>("msteams", { namespace, maxEntries, env });
}

async function storedVotes(pollId: string, accountId?: string) {
  const buckets = pluginStore<{ pollId: string; votes: Poll["votes"] }>(
    resolveMSTeamsAccountStateNamespace("poll-vote-buckets", accountId),
    32_032,
    process.env,
  );
  const votes: Poll["votes"] = {};
  for (const row of await buckets.entries()) {
    if (row.value.pollId === pollId) {
      Object.assign(votes, row.value.votes);
    }
  }
  return votes;
}

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

function stateStore() {
  const stateDir = tempDirs.make("openclaw-msteams-polls-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  return createMSTeamsPollStoreState();
}

beforeEach(() => {
  resetPluginStateStoreForTests();
  setMSTeamsRuntime(msteamsRuntimeStub);
});

describe("msteams polls", () => {
  it("builds poll cards with the question and selectable options", () => {
    const card = buildMSTeamsPollCard({ question: "Lunch?", options: ["Pizza", "Sushi"] });

    expect(card.pollId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(card.card).toMatchObject({
      type: "AdaptiveCard",
      body: [
        { type: "TextBlock", text: "Lunch?" },
        {
          type: "Input.ChoiceSet",
          choices: [
            { title: "Pizza", value: "0" },
            { title: "Sushi", value: "1" },
          ],
        },
        { type: "TextBlock", text: "Select one option." },
      ],
    });
  });

  it("extracts poll votes from activity values", () => {
    expect(extractMSTeamsPollVote({ value: { openclawPollId: "poll-1", choices: "0,1" } })).toEqual(
      { pollId: "poll-1", selections: ["0", "1"] },
    );
  });

  it("deduplicates selections before enforcing maxSelections", async () => {
    const store = stateStore();
    await store.createPoll(poll({ options: ["A", "B", "C"], maxSelections: 2 }));
    await store.recordVote({ pollId: "poll-1", voterId: "user-1", selections: ["0", "0", "1"] });
    expect((await storedVotes("poll-1"))["user-1"]).toEqual(["0", "1"]);
  });
  it("hashes external poll ids before using plugin-state keys", async () => {
    const store = stateStore();
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

  it("isolates poll metadata and vote buckets between accounts", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-msteams-polls-accounts-"));
    const defaultStore = createMSTeamsPollStoreState();
    const supportStore = createMSTeamsPollStoreState({ accountId: "support" });
    await defaultStore.createPoll(poll({ question: "Default?", votes: { shared: ["0"] } }));
    expect(await supportStore.getPoll("poll-1")).toBeNull();
    await supportStore.createPoll(poll({ question: "Support?", votes: { shared: ["1"] } }));
    await supportStore.recordVote({ pollId: "poll-1", voterId: "new-user", selections: ["1"] });
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    for (const [accountId, question, votes] of [
      ["default", "Default?", { shared: ["0"] }],
      ["support", "Support?", { shared: ["1"], "new-user": ["1"] }],
    ] as const) {
      expect(await createMSTeamsPollStoreState({ accountId }).getPoll("poll-1")).toMatchObject({
        question,
      });
      expect(await storedVotes("poll-1", accountId)).toEqual(votes);
    }
  });

  it("serializes concurrent votes for the same poll", async () => {
    const store = stateStore();
    await store.createPoll(poll({ id: "poll-race" }));

    await Promise.all([
      store.recordVote({ pollId: "poll-race", voterId: "user-a", selections: ["0"] }),
      store.recordVote({ pollId: "poll-race", voterId: "user-b", selections: ["1"] }),
    ]);

    await expect(storedVotes("poll-race")).resolves.toEqual({
      "user-a": ["0"],
      "user-b": ["1"],
    });
  });

  it("keeps large vote maps split across bounded rows", async () => {
    const store = stateStore();
    const votes = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [
        `user-${String(index).padStart(4, "0")}-${"x".repeat(160)}`,
        ["0"],
      ]),
    );

    await store.createPoll(poll({ id: "poll-large", votes }));
    await store.recordVote({ pollId: "poll-large", voterId: "user-new", selections: ["1"] });

    const stored = await storedVotes("poll-large");
    expect(Object.keys(stored)).toHaveLength(501);
    expect(stored["user-new"]).toEqual(["1"]);
  });

  it("bounds vote bucket scans while pruning 1003 existing polls", async () => {
    const expired = ["poll-expired-a", "poll-expired-b"];
    const removed = ["poll-old", ...Array.from({ length: 4 }, (_, i) => `poll-existing-${i}`)];
    const stateDir = tempDirs.make("openclaw-msteams-polls-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    // Pruning consumes only identity and timestamps, not poll/card/vote content.
    const metadataStore = pluginStore<Pick<Poll, "id" | "createdAt">>("polls", 2000, env);
    const voteBucketStore = pluginStore<{ pollId: string }>("poll-vote-buckets", 32_032, env);
    const baseMs = Date.now() - 60_000;
    const oldPollId = "poll-old";

    for (const [index, id] of [
      oldPollId,
      ...Array.from({ length: 1003 }, (_, entryIndex) => `poll-existing-${entryIndex}`),
    ].entries()) {
      await metadataStore.register(pollStateKey(id), {
        id,
        createdAt: new Date(baseMs + index).toISOString(),
      });
    }
    for (const id of expired) {
      await metadataStore.register(pollStateKey(id), {
        id,
        createdAt: new Date(baseMs - 31 * 24 * 60 * 60 * 1000).toISOString(),
      });
      await voteBucketStore.register(`${pollStateKey(id)}:0000`, { pollId: id });
    }
    // SHA-256("poll-old\0user-old") selects bucket 2 of 32.
    await voteBucketStore.register(`${pollStateKey(oldPollId)}:0002`, { pollId: oldPollId });

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
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const store = createMSTeamsPollStoreState();
    try {
      await store.createPoll(
        poll({
          id: "poll-new",
          question: "New?",
          createdAt: new Date(baseMs + 2_000_000).toISOString(),
          votes: { "user-new": ["1"] },
        }),
      );
    } finally {
      iterateSpy.mockRestore();
    }
    expect(bucketScans).toBeLessThanOrEqual(2);
    expect(await metadataStore.entries()).toHaveLength(1000);
    for (const id of [...expired, ...removed]) {
      await expect(store.getPoll(id)).resolves.toBeNull();
    }
    const buckets = await voteBucketStore.entries();
    expect(buckets.map((row) => row.value.pollId)).toEqual(["poll-new"]);
  });
  it.each(["delete", "null value", "invalid JSON"])(
    "preserves partial cleanup before a bucket %s failure",
    async (failure) => {
      const stateDir = tempDirs.make("openclaw-msteams-polls-");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const metadata = pluginStore<unknown>("polls", 2000, env);
      const buckets = pluginStore<unknown>("poll-vote-buckets", 32_032, env);
      const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      for (const id of ["expired-a", "expired-b"]) {
        await metadata.register(id, { id, createdAt: expiredAt });
      }
      for (const key of ["first", "failing", "later"]) {
        await buckets.register(key, {
          pollId: key === "later" ? "expired-b" : "expired-a",
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
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        const store = createMSTeamsPollStoreState();
        await expect(
          store.createPoll(
            poll({
              id: "new",
              question: "Pick",
              // A real bucket write invalidates the initial replacement-read snapshot.
              // The later prune read must decode the trigger-corrupted rows.
              votes: { voter: ["1"] },
            }),
          ),
        ).rejects.toThrow(
          failure === "null value"
            ? TypeError
            : failure === "invalid JSON"
              ? "Plugin state entry contains corrupt JSON."
              : "Failed to delete plugin state entry.",
        );
        const newPollKey = pollStateKey("new");
        const remaining = database
          .prepare(
            "SELECT namespace, entry_key FROM plugin_state_entries WHERE plugin_id = 'msteams' ORDER BY namespace, entry_key",
          )
          .all();
        expect(remaining).toEqual([
          // SHA-256("new\0voter") selects bucket 8 of 32.
          { namespace: "poll-vote-buckets", entry_key: `${newPollKey}:0008` },
          { namespace: "poll-vote-buckets", entry_key: "failing" },
          ...(failure === "invalid JSON"
            ? [{ namespace: "poll-vote-buckets", entry_key: "first" }]
            : []),
          { namespace: "poll-vote-buckets", entry_key: "later" },
          { namespace: "polls", entry_key: newPollKey },
          { namespace: "polls", entry_key: "expired-b" },
        ]);
      } finally {
        database.close();
      }
    },
  );
});
