import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWhatsAppPollResultsContext } from "./poll-results-context.js";
import {
  readWhatsAppPollRecord,
  recordWhatsAppPoll,
  WHATSAPP_POLL_CHAT_INDEX_STORES,
  WHATSAPP_POLL_RECORD_STORES,
  type WhatsAppPollOrigin,
} from "./poll-vote-store.js";
import { applyWhatsAppPollVote, WHATSAPP_POLL_TALLY_STORES } from "./poll-vote-tally-store.js";
import {
  installWhatsAppPollStateRuntimeForTest,
  type WhatsAppPollStateRuntimeForTest,
} from "./poll-vote.test-helper.js";

const HOME = "120363000000000001@g.us";
const OTHER = "120363000000000002@g.us";
const SECRET = new Uint8Array(32).fill(9);

let env: WhatsAppPollStateRuntimeForTest;
let voteClock = 1_760_000_000_000;

beforeEach(async () => {
  env = await installWhatsAppPollStateRuntimeForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

async function addPoll(params: {
  id: string;
  origin?: WhatsAppPollOrigin;
  recordedAt: number;
  options?: string[];
  question?: string;
  chatJids?: string[];
  creatorName?: string;
}) {
  await recordWhatsAppPoll(
    {
      accountId: "default",
      pollMessageId: params.id,
      origin: params.origin ?? "received",
      chatJids: params.chatJids ?? [HOME],
      creatorJids: ["15550000009@s.whatsapp.net"],
      creatorName: params.creatorName,
      question: params.question ?? `Question ${params.id}?`,
      secret: SECRET,
      options: params.options ?? ["Yes", "No"],
      selectableCount: 1,
      recordedAt: params.recordedAt,
    },
    { mode: "overwrite" },
  );
}

async function addVote(id: string, voter: string, selected: string[], name?: string) {
  const record = await readWhatsAppPollRecord("default", id);
  if (!record) {
    throw new Error(`missing poll ${id}`);
  }
  await applyWhatsAppPollVote({
    record,
    accountId: "default",
    pollMessageId: id,
    voter: { jids: [voter], name },
    selected,
    votedAtMs: ++voteClock,
  });
}

describe("readWhatsAppPollResultsContext", () => {
  it("returns the three newest polls of the chat with counts and names", async () => {
    const base = Date.now() - 100_000;
    await addPoll({ id: "P1", recordedAt: base });
    await addPoll({ id: "P2", recordedAt: base + 1, creatorName: "Dana" });
    await addPoll({ id: "P3", recordedAt: base + 2, origin: "sent" });
    await addPoll({ id: "P4", recordedAt: base + 3, options: ["Pizza", "Sushi"] });
    await addVote("P4", "15550000001@s.whatsapp.net", ["Pizza"], "Avi");
    await addVote("P4", "15550000002@s.whatsapp.net", ["Sushi"], "Noa");
    await addVote("P4", "11110000003@lid", ["Pizza"]);
    await addVote("P3", "15550000004@s.whatsapp.net", ["No"]);

    const context = await readWhatsAppPollResultsContext({
      accountId: "default",
      chatJids: [HOME],
    });
    expect(context).toMatchObject({
      label: "WhatsApp poll results",
      source: "whatsapp",
      type: "poll_results",
      payload: {
        note: "Stored latest selection per voter for polls in this chat. Mention only when asked about a poll.",
      },
    });
    const polls = context?.payload.polls ?? [];
    expect(polls.map((poll) => poll.poll_id)).toEqual(["P4", "P3", "P2"]);
    expect(polls[0]).toEqual({
      poll_id: "P4",
      question: "Question P4?",
      created_by: "+15550000009",
      created_at: new Date(base + 3).toISOString(),
      selectable_count: 1,
      voters_total: 3,
      options: [
        { option: "Pizza", votes: 2, voters: ["Avi", "unknown voter"] },
        { option: "Sushi", votes: 1, voters: ["Noa"] },
      ],
    });
    expect(polls[1]).toMatchObject({
      created_by: "assistant",
      voters_total: 1,
      options: [
        { option: "Yes", votes: 0, voters: [] },
        { option: "No", votes: 1, voters: ["+15550000004"] },
      ],
    });
    expect(polls[2]?.created_by).toBe("Dana");
  });

  it("returns nothing for another chat or another account", async () => {
    await addPoll({ id: "P1", recordedAt: Date.now() });
    expect(
      await readWhatsAppPollResultsContext({ accountId: "default", chatJids: [OTHER] }),
    ).toBeUndefined();
    expect(
      await readWhatsAppPollResultsContext({ accountId: "work", chatJids: [HOME] }),
    ).toBeUndefined();
    expect(env.logger.warn).not.toHaveBeenCalled();
  });

  it("skips index rows whose record is gone instead of spending the three slots", async () => {
    const base = Date.now() - 100_000;
    await addPoll({ id: "OLD", recordedAt: base });
    const index = env.openStore(WHATSAPP_POLL_CHAT_INDEX_STORES.received);
    for (let offset = 1; offset <= 5; offset++) {
      await index.register(
        `default:${HOME}:${String(base + offset).padStart(13, "0")}:GONE${offset}`,
        {
          v: 1,
          pollMessageId: `GONE${offset}`,
          origin: "received",
        },
      );
    }
    const context = await readWhatsAppPollResultsContext({
      accountId: "default",
      chatJids: [HOME],
    });
    expect(context?.payload.polls.map((poll) => poll.poll_id)).toEqual(["OLD"]);
  });

  it("shows 50 names and a +N more line while keeping the exact vote count", async () => {
    await addPoll({ id: "BIG", recordedAt: Date.now() });
    for (let index = 0; index < 60; index++) {
      await addVote(
        "BIG",
        `1555100${String(index).padStart(4, "0")}@s.whatsapp.net`,
        ["Yes"],
        `V${index}`,
      );
    }
    const [poll] =
      (await readWhatsAppPollResultsContext({ accountId: "default", chatJids: [HOME] }))?.payload
        .polls ?? [];
    const yes = poll?.options[0];
    expect(yes?.votes).toBe(60);
    expect(yes?.voters).toHaveLength(51);
    expect(yes?.voters.at(-1)).toBe("+10 more");
  });

  it("fits 4096 bytes by dropping names from the oldest poll first, then the oldest poll", async () => {
    const base = Date.now() - 100_000;
    const longOptions = ["A".repeat(400), "B".repeat(400)];
    await addPoll({ id: "OLDEST", recordedAt: base, options: longOptions });
    await addPoll({ id: "MIDDLE", recordedAt: base + 1, options: longOptions });
    await addPoll({ id: "NEWEST", recordedAt: base + 2, options: longOptions });
    for (const id of ["OLDEST", "MIDDLE", "NEWEST"]) {
      for (let index = 0; index < 30; index++) {
        await addVote(
          id,
          `1555200${String(index).padStart(4, "0")}@s.whatsapp.net`,
          [longOptions[index % 2] ?? ""],
          `Voter number ${index} with a long display name`,
        );
      }
    }
    const context = await readWhatsAppPollResultsContext({
      accountId: "default",
      chatJids: [HOME],
    });
    const bytes = Buffer.byteLength(JSON.stringify(context?.payload));
    expect(bytes).toBeLessThanOrEqual(4096);
    const polls = context?.payload.polls ?? [];
    expect(polls.map((poll) => poll.poll_id)).toEqual(["NEWEST", "MIDDLE"]);
    // The newest poll keeps its names; the trimmed one keeps exact counts.
    expect(polls[0]?.options[0]?.voters).toContain("Voter number 0 with a long display name");
    expect(polls[1]?.options.map((option) => option.voters)).toEqual([["+15 more"], ["+15 more"]]);
    expect(polls[1]?.options.map((option) => option.votes)).toEqual([15, 15]);
  });

  it("never exposes LID JIDs, the secret or option hashes", async () => {
    await addPoll({ id: "P1", recordedAt: Date.now(), options: ["Yes"] });
    await addVote("P1", "11110000003@lid", ["Yes"]);
    const json = JSON.stringify(
      await readWhatsAppPollResultsContext({ accountId: "default", chatJids: [HOME] }),
    );
    expect(json).not.toContain("@lid");
    expect(json).not.toContain(Buffer.from(SECRET).toString("base64"));
    expect(json).not.toContain(Buffer.from(SECRET).toString("hex"));
    expect(json).not.toContain(createHash("sha256").update("Yes").digest("hex"));
  });

  it.each([
    [
      WHATSAPP_POLL_CHAT_INDEX_STORES.sent.namespace,
      "entriesInKeyRange",
      "PLUGIN_STATE_READ_FAILED",
    ],
    [WHATSAPP_POLL_RECORD_STORES.received.namespace, "lookup", "PLUGIN_STATE_CORRUPT"],
    [
      WHATSAPP_POLL_TALLY_STORES.received.namespace,
      "entriesInKeyRange",
      "PLUGIN_STATE_OPEN_FAILED",
    ],
    [WHATSAPP_POLL_RECORD_STORES.sent.namespace, "lookup", undefined],
  ] as const)(
    "returns no block and one warning when %s.%s throws %s",
    async (namespace, method, code) => {
      await addPoll({ id: "P1", recordedAt: Date.now() });
      env.faults.push({ namespace, method, code });
      await expect(
        readWhatsAppPollResultsContext({ accountId: "default", chatJids: [HOME] }),
      ).resolves.toBeUndefined();
      expect(env.logger.warn).toHaveBeenCalledTimes(1);
      expect(env.logger.warn).toHaveBeenCalledWith("whatsapp poll results read failed", {
        code: code ?? "unknown",
      });
    },
  );
});
