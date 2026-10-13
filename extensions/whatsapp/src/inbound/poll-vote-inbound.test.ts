import type { WAMessage } from "baileys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordWhatsAppPoll,
  WHATSAPP_POLL_RECORD_STORES,
  type WhatsAppPollOrigin,
} from "../poll-vote-store.js";
import { readWhatsAppPollTally, WHATSAPP_POLL_TALLY_STORES } from "../poll-vote-tally-store.js";
import {
  buildWhatsAppPollVoteMessageForTest,
  hashWhatsAppPollOptionForTest,
  installWhatsAppPollStateRuntimeForTest,
  type WhatsAppPollStateRuntimeForTest,
} from "../poll-vote.test-helper.js";
import { describeReplyContext } from "./extract.js";
import { getWhatsAppPollVoteMeta, resolveWhatsAppPollVote } from "./poll-vote-inbound.js";

const SELF_PN = "15550000001@s.whatsapp.net";
const SELF_LID = "77770000001@lid";
const GROUP = "120363000000000001@g.us";
const DM = "15550002222@s.whatsapp.net";
const MEMBER = "15550003333@s.whatsapp.net";
const SECRET = new Uint8Array(32).fill(7);
const deps = { accountId: "default", selfJids: [SELF_PN, SELF_LID] };

let env: WhatsAppPollStateRuntimeForTest;

beforeEach(async () => {
  env = await installWhatsAppPollStateRuntimeForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

async function addPoll(params: {
  id?: string;
  origin: WhatsAppPollOrigin;
  chatJid: string;
  creatorJids?: string[];
}) {
  await recordWhatsAppPoll(
    {
      accountId: "default",
      pollMessageId: params.id ?? "POLL1",
      origin: params.origin,
      chatJids: [params.chatJid],
      creatorJids: params.creatorJids ?? (params.origin === "sent" ? [SELF_PN, SELF_LID] : [DM]),
      question: "Pizza or sushi?",
      secret: SECRET,
      options: ["Pizza", "Sushi"],
      selectableCount: 1,
    },
    { mode: "overwrite" },
  );
}

function voteMessage(
  overrides: Partial<Parameters<typeof buildWhatsAppPollVoteMessageForTest>[0]> = {},
): WAMessage {
  return buildWhatsAppPollVoteMessageForTest({
    id: "VOTE1",
    remoteJid: DM,
    pollMsgId: "POLL1",
    pollCreatorJid: SELF_PN,
    voterJid: DM,
    secret: SECRET,
    selectedOptions: ["Sushi"],
    pushName: "Dana",
    senderTimestampMs: 1_760_000_000_000,
    ...overrides,
  }) as unknown as WAMessage;
}

function groupVote(
  overrides: Partial<Parameters<typeof buildWhatsAppPollVoteMessageForTest>[0]> = {},
) {
  return voteMessage({ remoteJid: GROUP, participant: MEMBER, voterJid: MEMBER, ...overrides });
}

async function tallyRows(origin: WhatsAppPollOrigin) {
  return await env.openStore(WHATSAPP_POLL_TALLY_STORES[origin]).entries();
}

describe("resolveWhatsAppPollVote", () => {
  it("passes non-vote messages through", async () => {
    const msg = { key: { id: "T1", remoteJid: DM }, message: { conversation: "hi" } } as WAMessage;
    expect(await resolveWhatsAppPollVote(msg, deps)).toEqual({ kind: "not-a-vote" });
  });

  it.each(["sent", "received"] as const)(
    "counts a group vote on a %s poll and completes without waking anyone",
    async (origin) => {
      await addPoll({
        origin,
        chatJid: GROUP,
        creatorJids: origin === "sent" ? undefined : [MEMBER],
      });
      const msg = groupVote({ pollCreatorJid: origin === "sent" ? SELF_PN : MEMBER });
      expect(await resolveWhatsAppPollVote(msg, deps)).toEqual({ kind: "completed" });
      const rows = await tallyRows(origin);
      expect(rows.map((row) => row.key)).toEqual([`default:POLL1:${MEMBER}`]);
      expect(rows[0]?.value).toMatchObject({ name: "Dana", selected: ["Sushi"] });
      expect(env.logger.warn).not.toHaveBeenCalled();
    },
  );

  it("delivers a direct-chat vote on the agent's poll as a message quoting the poll", async () => {
    await addPoll({ origin: "sent", chatJid: DM });
    const msg = voteMessage();
    const result = await resolveWhatsAppPollVote(msg, deps);
    expect(result.kind).toBe("deliver");
    const derived = (result as { message: WAMessage }).message;
    expect(derived.key).toEqual(msg.key);
    expect(derived.messageTimestamp).toBe(msg.messageTimestamp);
    expect(derived.message?.extendedTextMessage?.text).toBe("Poll vote: Sushi");
    expect(derived.message?.extendedTextMessage?.contextInfo).toMatchObject({
      stanzaId: "POLL1",
      participant: SELF_PN,
      quotedMessage: {
        pollCreationMessageV3: {
          name: "Pizza or sushi?",
          options: [{ optionName: "Pizza" }, { optionName: "Sushi" }],
        },
      },
    });
    const reply = describeReplyContext(derived.message ?? undefined);
    expect(reply?.id).toBe("POLL1");
    expect(reply?.body).toBe("Pizza or sushi?\n- Pizza\n- Sushi");
    expect(getWhatsAppPollVoteMeta(derived)).toEqual({ pollMessageId: "POLL1" });
    expect(getWhatsAppPollVoteMeta(msg)).toBeUndefined();
    expect((await tallyRows("sent")).map((row) => row.key)).toEqual([`default:POLL1:${DM}`]);
  });

  it("delivers a retraction as Poll vote removed and deletes the voter", async () => {
    await addPoll({ origin: "sent", chatJid: DM });
    await resolveWhatsAppPollVote(voteMessage(), deps);
    const result = await resolveWhatsAppPollVote(
      voteMessage({ id: "VOTE2", selectedOptions: [], senderTimestampMs: 1_760_000_000_500 }),
      deps,
    );
    expect((result as { message: WAMessage }).message.message?.extendedTextMessage?.text).toBe(
      "Poll vote removed",
    );
    expect(await tallyRows("sent")).toEqual([]);
  });

  it("counts but does not deliver a direct-chat vote on the other side's poll", async () => {
    await addPoll({ origin: "received", chatJid: DM });
    const msg = voteMessage({ pollCreatorJid: DM });
    expect(await resolveWhatsAppPollVote(msg, deps)).toEqual({ kind: "completed" });
    expect(await tallyRows("received")).toHaveLength(1);
  });

  it("counts but does not deliver the account's own vote", async () => {
    await addPoll({ origin: "sent", chatJid: DM });
    const msg = voteMessage({ fromMe: true, voterJid: SELF_PN });
    expect(await resolveWhatsAppPollVote(msg, deps)).toEqual({ kind: "completed" });
    expect((await tallyRows("sent")).map((row) => row.key)).toEqual([`default:POLL1:${SELF_PN}`]);
  });

  it("decodes a vote on a linked-phone poll whose record has no creator JID", async () => {
    await addPoll({ origin: "received", chatJid: GROUP, creatorJids: [] });
    expect(await resolveWhatsAppPollVote(groupVote({ pollCreatorJid: SELF_LID }), deps)).toEqual({
      kind: "completed",
    });
    expect(await tallyRows("received")).toHaveLength(1);
  });

  it("completes a vote on an unknown poll silently, without a tally row", async () => {
    expect(await resolveWhatsAppPollVote(voteMessage(), deps)).toEqual({ kind: "completed" });
    expect(await tallyRows("sent")).toEqual([]);
    expect(env.logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    {
      reason: "chat-mismatch",
      msg: () => voteMessage({ remoteJid: "15559999999@s.whatsapp.net" }),
      attempts: 0,
    },
    {
      reason: "decrypt-failed",
      msg: () => voteMessage({ secret: new Uint8Array(32).fill(1) }),
      attempts: 2,
    },
    {
      reason: "unknown-options",
      msg: () => voteMessage({ selectedHashes: [hashWhatsAppPollOptionForTest("Burger")] }),
      attempts: 1,
    },
  ])("logs one rejection for $reason without secret, hashes or names", async (scenario) => {
    await addPoll({ origin: "sent", chatJid: DM });
    expect(await resolveWhatsAppPollVote(scenario.msg(), deps)).toEqual({ kind: "completed" });
    expect(env.logger.warn).toHaveBeenCalledTimes(1);
    const [message, fields] = env.logger.warn.mock.calls[0] ?? [];
    expect(message).toBe("whatsapp poll vote rejected");
    expect(fields).toMatchObject({
      reason: scenario.reason,
      origin: "sent",
      pollMessageId: "POLL1",
      attempts: scenario.attempts,
    });
    expect(fields.chat).not.toContain("15550002222");
    const logged = JSON.stringify(env.logger.warn.mock.calls);
    for (const leak of [
      Buffer.from(SECRET).toString("base64"),
      Buffer.from(SECRET).toString("hex"),
      hashWhatsAppPollOptionForTest("Sushi").toString("hex"),
      hashWhatsAppPollOptionForTest("Burger").toString("hex"),
      "Sushi",
      "Burger",
      "Dana",
    ]) {
      expect(logged).not.toContain(leak);
    }
    expect(await tallyRows("sent")).toEqual([]);
  });

  it("rethrows a transient record read failure so the drain replays the vote", async () => {
    await addPoll({ origin: "sent", chatJid: DM });
    env.faults.push({
      namespace: WHATSAPP_POLL_RECORD_STORES.sent.namespace,
      method: "lookup",
      code: "PLUGIN_STATE_READ_FAILED",
    });
    await expect(resolveWhatsAppPollVote(voteMessage(), deps)).rejects.toMatchObject({
      code: "PLUGIN_STATE_READ_FAILED",
    });
  });

  it("completes when the record read fails permanently", async () => {
    env.faults.push({
      namespace: WHATSAPP_POLL_RECORD_STORES.sent.namespace,
      method: "lookup",
      code: "PLUGIN_STATE_CORRUPT",
    });
    expect(await resolveWhatsAppPollVote(voteMessage(), deps)).toEqual({ kind: "completed" });
    expect(env.logger.warn).toHaveBeenCalledWith("whatsapp poll store read failed", {
      code: "PLUGIN_STATE_CORRUPT",
    });
  });

  it("does not hold a group lane on a failing tally write, but replays a deliverable vote", async () => {
    await addPoll({ origin: "sent", chatJid: GROUP });
    await addPoll({ id: "POLL2", origin: "sent", chatJid: DM });
    env.faults.push({
      namespace: WHATSAPP_POLL_TALLY_STORES.sent.namespace,
      method: "register",
      code: "PLUGIN_STATE_WRITE_FAILED",
    });
    expect(await resolveWhatsAppPollVote(groupVote(), deps)).toEqual({ kind: "completed" });
    expect(env.logger.warn).toHaveBeenCalledWith("whatsapp poll store tally write failed", {
      code: "PLUGIN_STATE_WRITE_FAILED",
    });
    await expect(
      resolveWhatsAppPollVote(voteMessage({ pollMsgId: "POLL2" }), deps),
    ).rejects.toMatchObject({ code: "PLUGIN_STATE_WRITE_FAILED" });
  });

  it("stores the voter's E.164 when the inbound resolver knows it", async () => {
    await addPoll({ origin: "sent", chatJid: GROUP });
    await resolveWhatsAppPollVote(groupVote(), {
      ...deps,
      resolveInboundJid: async (jid) => (jid === MEMBER ? "+15550003333" : null),
    });
    const record = { ...(await env.openStore(WHATSAPP_POLL_RECORD_STORES.sent).entries())[0] };
    expect(record).toBeDefined();
    const [voter] =
      (await readWhatsAppPollTally({
        record: (record as { value: never }).value,
        accountId: "default",
        pollMessageId: "POLL1",
      })) ?? [];
    expect(voter).toMatchObject({ e164: "+15550003333", name: "Dana" });
  });
});
