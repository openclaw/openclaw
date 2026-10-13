import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decodeWhatsAppPollVote } from "./poll-vote-decode.js";
import type { WhatsAppPollRecord } from "./poll-vote-store.js";
import { encryptWhatsAppPollVoteForTest } from "./poll-vote.test-helper.js";

const SECRET = randomBytes(32);
const GROUP = "120363000000000001@g.us";
const AGENT_PN = "15550000001@s.whatsapp.net";
const AGENT_LID = "11110000001@lid";
const VOTER_PN = "15550000002@s.whatsapp.net";
const VOTER_LID = "11110000002@lid";

function record(overrides: Partial<WhatsAppPollRecord> = {}): WhatsAppPollRecord {
  return {
    v: 1,
    origin: "sent",
    chatJids: [GROUP],
    creatorJids: [AGENT_PN, AGENT_LID],
    question: "Lunch?",
    secret: SECRET.toString("base64"),
    options: ["Pizza", "Sushi", "Salad"],
    selectableCount: 0,
    recordedAt: 1,
    ...overrides,
  };
}

function encrypt(creator: string, voter: string, selected: string[], secret: Uint8Array = SECRET) {
  return encryptWhatsAppPollVoteForTest({
    secret,
    pollMsgId: "POLL1",
    pollCreatorJid: creator,
    voterJid: voter,
    selectedOptions: selected,
  });
}

describe("decodeWhatsAppPollVote", () => {
  it.each([
    ["PN x PN", AGENT_PN, VOTER_PN],
    ["LID x LID", AGENT_LID, VOTER_LID],
    ["PN x LID", AGENT_PN, VOTER_LID],
  ])("decodes %s pairings", async (_label, creator, voter) => {
    const result = await decodeWhatsAppPollVote({
      record: record(),
      vote: encrypt(creator, voter, ["Sushi"]),
      pollMessageId: "POLL1",
      creatorJids: [],
      voterJids: [VOTER_PN, VOTER_LID],
      chat: { remoteJid: GROUP },
    });
    expect(result).toEqual({ ok: true, selected: ["Sushi"] });
  });

  it("ignores device suffixes on creator and voter JIDs", async () => {
    const result = await decodeWhatsAppPollVote({
      record: record({ creatorJids: [] }),
      vote: encrypt(AGENT_PN, VOTER_PN, ["Pizza"]),
      pollMessageId: "POLL1",
      creatorJids: ["15550000001:12@s.whatsapp.net"],
      voterJids: ["15550000002:12@s.whatsapp.net"],
      chat: { remoteJid: GROUP },
    });
    expect(result).toEqual({ ok: true, selected: ["Pizza"] });
  });

  it("decodes votes on a poll created by someone other than the agent", async () => {
    const creator = "15550000003@s.whatsapp.net";
    const result = await decodeWhatsAppPollVote({
      record: record({ origin: "received", creatorJids: [creator] }),
      vote: encrypt(creator, VOTER_PN, ["Salad"]),
      pollMessageId: "POLL1",
      creatorJids: [],
      voterJids: [VOTER_PN],
      chat: { remoteJid: GROUP },
    });
    expect(result).toEqual({ ok: true, selected: ["Salad"] });
  });

  it("rejects a vote from another chat before trying to decrypt", async () => {
    const resolveInboundJid = vi.fn(async () => "+15550000099");
    const result = await decodeWhatsAppPollVote({
      record: record(),
      vote: encrypt(AGENT_PN, VOTER_PN, ["Pizza"]),
      pollMessageId: "POLL1",
      creatorJids: [],
      voterJids: [VOTER_PN],
      chat: { remoteJid: "120363000000000002@g.us", resolveInboundJid },
    });
    expect(result).toEqual({ ok: false, reason: "chat-mismatch", attempts: 0 });
  });

  it("matches a direct chat through remoteJidAlt or the inbound resolver", async () => {
    const dm = record({ chatJids: [VOTER_PN] });
    const vote = encrypt(AGENT_PN, VOTER_LID, ["Pizza"]);
    const viaAlt = await decodeWhatsAppPollVote({
      record: dm,
      vote,
      pollMessageId: "POLL1",
      creatorJids: [],
      voterJids: [VOTER_LID],
      chat: { remoteJid: VOTER_LID, remoteJidAlt: VOTER_PN },
    });
    expect(viaAlt).toEqual({ ok: true, selected: ["Pizza"] });
    const viaResolver = await decodeWhatsAppPollVote({
      record: dm,
      vote,
      pollMessageId: "POLL1",
      creatorJids: [],
      voterJids: [VOTER_LID],
      chat: { remoteJid: VOTER_LID, resolveInboundJid: async () => "+15550000002" },
    });
    expect(viaResolver).toEqual({ ok: true, selected: ["Pizza"] });
  });

  it("reports decrypt-failed with the number of pairings tried for a wrong secret", async () => {
    const result = await decodeWhatsAppPollVote({
      record: record(),
      vote: encrypt(AGENT_PN, VOTER_PN, ["Pizza"], randomBytes(32)),
      pollMessageId: "POLL1",
      creatorJids: [],
      voterJids: [VOTER_PN, VOTER_LID],
      chat: { remoteJid: GROUP },
    });
    expect(result).toEqual({ ok: false, reason: "decrypt-failed", attempts: 4 });
  });

  it("decodes multiple selections and an empty retraction", async () => {
    const decode = (selected: string[]) =>
      decodeWhatsAppPollVote({
        record: record(),
        vote: encrypt(AGENT_PN, VOTER_PN, selected),
        pollMessageId: "POLL1",
        creatorJids: [],
        voterJids: [VOTER_PN],
        chat: { remoteJid: GROUP },
      });
    expect(await decode(["Pizza", "Salad"])).toEqual({ ok: true, selected: ["Pizza", "Salad"] });
    expect(await decode([])).toEqual({ ok: true, selected: [] });
  });

  it("drops unknown option hashes and rejects a vote with only unknown ones", async () => {
    const decode = (selected: string[]) =>
      decodeWhatsAppPollVote({
        record: record(),
        vote: encrypt(AGENT_PN, VOTER_PN, selected),
        pollMessageId: "POLL1",
        creatorJids: [],
        voterJids: [VOTER_PN],
        chat: { remoteJid: GROUP },
      });
    expect(await decode(["Pizza", "Burger"])).toEqual({ ok: true, selected: ["Pizza"] });
    expect(await decode(["Burger"])).toEqual({ ok: false, reason: "unknown-options", attempts: 1 });
  });
});
