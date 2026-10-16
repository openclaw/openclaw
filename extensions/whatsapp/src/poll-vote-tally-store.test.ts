import { proto } from "baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deserializeWhatsAppDurableInboundMessage,
  serializeWhatsAppDurableInboundMessage,
} from "./inbound/durable-payload.js";
import {
  WHATSAPP_POLL_TALLY_STORES,
  WHATSAPP_POLL_TTL_MS,
  type WhatsAppPollRecord,
} from "./poll-vote-store.js";
import {
  applyWhatsAppPollVote,
  normalizeWhatsAppPollVoteTimestampMs,
  readWhatsAppPollTally,
} from "./poll-vote-tally-store.js";
import {
  installWhatsAppPollStateRuntimeForTest,
  type WhatsAppPollStateRuntimeForTest,
} from "./poll-vote.test-helper.js";

const PN = "15550003333@s.whatsapp.net";
const LID = "88880003333@lid";
const ACCOUNT = { accountId: "default", self: { jid: "15550001111@s.whatsapp.net" } };
const PREFIX = "default:+15550001111:";

function pollRecord(overrides: Partial<WhatsAppPollRecord> = {}): WhatsAppPollRecord {
  return {
    v: 2,
    owner: { e164: "+15550001111" },
    origin: "sent",
    chatJids: ["120363000000000001@g.us"],
    creatorJids: [],
    question: "Pizza or sushi?",
    secret: Buffer.alloc(32, 1).toString("base64"),
    options: ["Pizza", "Sushi", "Salad"],
    selectableCount: 0,
    recordedAt: Date.now(),
    ...overrides,
  };
}

let env: WhatsAppPollStateRuntimeForTest;

beforeEach(async () => {
  env = await installWhatsAppPollStateRuntimeForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

async function vote(params: {
  record?: WhatsAppPollRecord;
  pollMessageId?: string;
  jids: string[];
  selected: string[];
  votedAtMs: number;
  name?: string;
}) {
  return await applyWhatsAppPollVote({
    record: params.record ?? pollRecord(),
    account: ACCOUNT,
    pollMessageId: params.pollMessageId ?? "POLL1",
    voter: { jids: params.jids, name: params.name },
    selected: params.selected,
    votedAtMs: params.votedAtMs,
  });
}

async function tally(record = pollRecord(), pollMessageId = "POLL1") {
  return await readWhatsAppPollTally({ record, account: ACCOUNT, pollMessageId });
}

async function storedRows() {
  const rows = await env.openStore(WHATSAPP_POLL_TALLY_STORES.sent).entries();
  return rows.map(({ key, value }) => ({ key, value }));
}

describe("WhatsApp poll tally store", () => {
  it("stores a vote, replaces it on change, and removes it on retraction", async () => {
    expect(await vote({ jids: [PN], selected: ["Pizza"], votedAtMs: 1000, name: "Dana" })).toBe(
      "applied",
    );
    expect(await tally()).toEqual([
      {
        voterKey: PN,
        voterJids: [PN],
        name: "Dana",
        selected: ["Pizza"],
        votedAtMs: 1000,
      },
    ]);

    await vote({ jids: [PN], selected: ["Sushi", "Salad"], votedAtMs: 2000 });
    const changed = await tally();
    expect(changed).toHaveLength(1);
    expect(changed?.[0]).toMatchObject({ name: "Dana", selected: ["Sushi", "Salad"] });

    await vote({ jids: [PN], selected: [], votedAtMs: 3000 });
    expect(await tally()).toEqual([]);
    expect(await storedRows()).toEqual([
      {
        key: `${PREFIX}POLL1:${PN}`,
        value: { v: 1, voterJids: [PN], selected: [], votedAtMs: 3000 },
      },
    ]);
  });

  it("ignores a vote older than the stored one", async () => {
    await vote({ jids: [PN], selected: ["Sushi"], votedAtMs: 5000 });
    expect(await vote({ jids: [PN], selected: ["Pizza"], votedAtMs: 4000 })).toBe("stale");
    expect(await vote({ jids: [PN], selected: [], votedAtMs: 4999 })).toBe("stale");
    expect((await tally())?.[0]?.selected).toEqual(["Sushi"]);
  });

  it("keeps a retraction's timestamp so an older vote arriving late stays retracted", async () => {
    await vote({ jids: [PN], selected: ["Sushi"], votedAtMs: 1000, name: "Dana" });
    expect(await vote({ jids: [PN], selected: [], votedAtMs: 3000 })).toBe("applied");
    expect(await vote({ jids: [PN], selected: ["Pizza"], votedAtMs: 2000 })).toBe("stale");
    expect(await vote({ jids: [PN], selected: ["Pizza"], votedAtMs: 2999 })).toBe("stale");
    expect(await tally()).toEqual([]);
    expect(await storedRows()).toEqual([
      {
        key: `${PREFIX}POLL1:${PN}`,
        value: { v: 1, voterJids: [PN], selected: [], votedAtMs: 3000 },
      },
    ]);
  });

  it("lets a vote at or after the retraction replace the watermark", async () => {
    await vote({ jids: [PN], selected: ["Sushi"], votedAtMs: 1000 });
    await vote({ jids: [PN], selected: [], votedAtMs: 3000 });
    expect(await vote({ jids: [PN], selected: ["Pizza"], votedAtMs: 3000, name: "Dana" })).toBe(
      "applied",
    );
    expect(await tally()).toEqual([
      { voterKey: PN, voterJids: [PN], name: "Dana", selected: ["Pizza"], votedAtMs: 3000 },
    ]);
    expect(await storedRows()).toHaveLength(1);
  });

  it("rejects a late LID-only vote older than a PN+LID retraction", async () => {
    await vote({ jids: [PN, LID], selected: ["Sushi"], votedAtMs: 1000 });
    expect(await vote({ jids: [PN], selected: [], votedAtMs: 3000 })).toBe("applied");
    expect(await vote({ jids: [LID], selected: ["Pizza"], votedAtMs: 2000 })).toBe("stale");
    expect(await tally()).toEqual([]);
  });

  it("hides a watermark row from the tally even when it is the voter's only row", async () => {
    expect(await vote({ jids: [PN], selected: [], votedAtMs: 1000 })).toBe("applied");
    expect(await tally()).toEqual([]);
    expect(await storedRows()).toHaveLength(1);
  });

  it("keeps one row when the same voter arrives as LID and later as PN", async () => {
    await vote({ jids: [LID], selected: ["Pizza"], votedAtMs: 1000 });
    await vote({
      jids: [`${PN.split("@")[0]}:12@s.whatsapp.net`, LID],
      selected: ["Sushi"],
      votedAtMs: 2000,
    });
    const rows = await env.openStore(WHATSAPP_POLL_TALLY_STORES.sent).entries();
    expect(rows.map((row) => row.key)).toEqual([`${PREFIX}POLL1:${PN}`]);
    expect(await tally()).toEqual([
      expect.objectContaining({ voterKey: PN, voterJids: [PN, LID], selected: ["Sushi"] }),
    ]);
  });

  it("retracts a PN+LID vote when the retraction arrives with the LID only", async () => {
    await vote({ jids: [PN, LID], selected: ["Pizza"], votedAtMs: 1000 });
    expect(await vote({ jids: [LID], selected: [], votedAtMs: 2000 })).toBe("applied");
    expect(await tally()).toEqual([]);
    expect(await storedRows()).toEqual([
      {
        key: `${PREFIX}POLL1:${PN}`,
        value: { v: 1, voterJids: [LID, PN], selected: [], votedAtMs: 2000 },
      },
    ]);
  });

  it("ignores a stale LID-only vote after a newer PN+LID vote, and a PN-only retraction clears all", async () => {
    await vote({ jids: [PN, LID], selected: ["Sushi"], votedAtMs: 2000 });
    expect(await vote({ jids: [LID], selected: ["Pizza"], votedAtMs: 1000 })).toBe("stale");
    const rows = await env.openStore(WHATSAPP_POLL_TALLY_STORES.sent).entries();
    expect(rows.map((row) => row.key)).toEqual([`${PREFIX}POLL1:${PN}`]);

    expect(await vote({ jids: [PN], selected: [], votedAtMs: 3000 })).toBe("applied");
    expect(await tally()).toEqual([]);
    expect(await storedRows()).toHaveLength(1);
  });

  it("replaces a PN+LID vote when the change arrives with the LID only", async () => {
    await vote({ jids: [PN, LID], selected: ["Pizza"], votedAtMs: 1000, name: "Dana" });
    await vote({ jids: [LID], selected: ["Salad"], votedAtMs: 2000 });
    const rows = await env.openStore(WHATSAPP_POLL_TALLY_STORES.sent).entries();
    expect(rows).toHaveLength(1);
    expect(await tally()).toEqual([
      expect.objectContaining({ name: "Dana", selected: ["Salad"], voterJids: [LID, PN] }),
    ]);
  });

  it("collapses older duplicate rows on read", async () => {
    const store = env.openStore(WHATSAPP_POLL_TALLY_STORES.sent);
    await store.register(`${PREFIX}POLL1:${LID}`, {
      v: 1,
      voterJids: [LID],
      selected: ["Pizza"],
      votedAtMs: 1000,
    });
    await store.register(`${PREFIX}POLL1:${PN}`, {
      v: 1,
      voterJids: [PN, LID],
      selected: ["Salad"],
      votedAtMs: 2000,
    });
    expect(await tally()).toEqual([expect.objectContaining({ voterKey: PN, selected: ["Salad"] })]);
  });

  it("separates namespaces by origin and expires rows with the poll record", async () => {
    const recordedAt = Date.now() - 60_000;
    const received = pollRecord({ origin: "received", recordedAt });
    const writeStartedAt = Date.now();
    await vote({ record: received, jids: [PN], selected: ["Pizza"], votedAtMs: 1000 });
    // The store stamps expiry at write time; a cold SQLite open can delay that by seconds.
    const writeWindowMs = Date.now() - writeStartedAt;
    expect(await env.openStore(WHATSAPP_POLL_TALLY_STORES.sent).entries()).toEqual([]);
    const [row] = await env.openStore(WHATSAPP_POLL_TALLY_STORES.received).entries();
    expect(row?.key).toBe(`${PREFIX}POLL1:${PN}`);
    const drift = (row?.expiresAt ?? 0) - (recordedAt + WHATSAPP_POLL_TTL_MS);
    expect(drift).toBeGreaterThanOrEqual(0);
    expect(drift).toBeLessThanOrEqual(writeWindowMs);
    expect(await tally(pollRecord({ origin: "sent" }))).toEqual([]);
    expect(await tally(received)).toHaveLength(1);
  });

  it("isolates polls whose ids share a prefix", async () => {
    await vote({ pollMessageId: "ab", jids: [PN], selected: ["Pizza"], votedAtMs: 1000 });
    await vote({ pollMessageId: "abc", jids: [LID], selected: ["Sushi"], votedAtMs: 1000 });
    await vote({ pollMessageId: "ab:x", jids: [LID], selected: ["Salad"], votedAtMs: 1000 });
    expect((await tally(pollRecord(), "ab"))?.map((voter) => voter.voterKey)).toEqual([PN]);
    expect((await tally(pollRecord(), "abc"))?.map((voter) => voter.voterKey)).toEqual([LID]);
  });

  it.each(["PLUGIN_STATE_WRITE_FAILED", "PLUGIN_STATE_READ_FAILED"])(
    "rethrows %s so ingress replays",
    async (code) => {
      env.faults.push({
        namespace: WHATSAPP_POLL_TALLY_STORES.sent.namespace,
        method: code === "PLUGIN_STATE_WRITE_FAILED" ? "register" : "lookup",
        code,
      });
      await expect(
        vote({ jids: [PN], selected: ["Pizza"], votedAtMs: 1000 }),
      ).rejects.toMatchObject({ code });
      expect(env.logger.warn).not.toHaveBeenCalled();
    },
  );

  it.each(["PLUGIN_STATE_LIMIT_EXCEEDED", "PLUGIN_STATE_CORRUPT"])(
    "returns skipped with one warning for %s",
    async (code) => {
      env.faults.push({
        namespace: WHATSAPP_POLL_TALLY_STORES.sent.namespace,
        method: "register",
        code,
      });
      expect(await vote({ jids: [PN], selected: ["Pizza"], votedAtMs: 1000 })).toBe("skipped");
      expect(env.logger.warn).toHaveBeenCalledTimes(1);
      expect(env.logger.warn).toHaveBeenCalledWith("whatsapp poll store tally write failed", {
        code,
      });
    },
  );

  it("skips a vote without a poll id or voter JID", async () => {
    expect(await vote({ pollMessageId: " ", jids: [PN], selected: ["Pizza"], votedAtMs: 1 })).toBe(
      "skipped",
    );
    expect(await vote({ jids: [], selected: ["Pizza"], votedAtMs: 1 })).toBe("skipped");
    expect(await storedRows()).toEqual([]);
  });

  it("drops selections that are not options of the recorded poll", async () => {
    await vote({ jids: [PN], selected: ["Pizza"], votedAtMs: 1000 });
    expect((await tally(pollRecord({ options: ["Sushi"] })))?.[0]?.selected).toEqual([]);
  });
});

describe("normalizeWhatsAppPollVoteTimestampMs", () => {
  it("reads senderTimestampMs after protobuf decode and durable queue round-trip", () => {
    const decoded = proto.Message.decode(
      proto.Message.encode({
        pollUpdateMessage: { senderTimestampMs: 1_760_000_000_123 },
      }).finish(),
    );
    const replayed = deserializeWhatsAppDurableInboundMessage(
      serializeWhatsAppDurableInboundMessage({
        key: { id: "VOTE1", remoteJid: PN },
        message: decoded,
        messageTimestamp: 1_760_000_000,
      }),
    );
    const raw = replayed.message?.pollUpdateMessage?.senderTimestampMs;
    expect(typeof raw).toBe("string");
    expect(normalizeWhatsAppPollVoteTimestampMs(raw, replayed.messageTimestamp)).toBe(
      1_760_000_000_123,
    );
    expect(
      normalizeWhatsAppPollVoteTimestampMs(decoded.pollUpdateMessage?.senderTimestampMs, undefined),
    ).toBe(1_760_000_000_123);
  });

  it("falls back to the message timestamp when senderTimestampMs is missing or malformed", () => {
    expect(normalizeWhatsAppPollVoteTimestampMs(null, 1_760_000_000)).toBe(1_760_000_000_000);
    expect(normalizeWhatsAppPollVoteTimestampMs("garbage", "1760000000")).toBe(1_760_000_000_000);
    expect(normalizeWhatsAppPollVoteTimestampMs(undefined, undefined)).toBe(0);
  });
});
