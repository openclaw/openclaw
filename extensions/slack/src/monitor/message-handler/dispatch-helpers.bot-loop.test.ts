import {
  createPairLoopGuard,
  resolvePairLoopGuardSettings,
  type PairLoopGuardConfig,
} from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import { describe, expect, it } from "vitest";
import { resolveSlackBotLoopProtection } from "./dispatch-helpers.js";
import type { PreparedSlackMessage } from "./types.js";

function prepared(message: {
  channel: string;
  thread_ts?: string;
  ts?: string;
  bot_id?: string;
}): PreparedSlackMessage {
  return {
    message: { type: "message", bot_id: "B_PEER", ...message },
    ctx: { botId: "B_SELF", botUserId: "U_SELF", cfg: {} },
    route: { accountId: "default" },
    account: { config: {} },
    channelConfig: null,
  } as unknown as PreparedSlackMessage;
}

function createAdmission(config: PairLoopGuardConfig) {
  const guard = createPairLoopGuard();
  return (
    channel: string,
    timestampFraction: string,
    senderBotId = "B_PEER",
    threadTs: string | null = "1700000000.001",
  ): boolean => {
    const event = prepared({
      channel,
      bot_id: senderBotId,
      ts: `1700000000.${timestampFraction}`,
      ...(threadTs === null ? {} : { thread_ts: threadTs }),
    });
    event.account.config.botLoopProtection = config;
    const facts = resolveSlackBotLoopProtection(event);
    if (!facts) {
      throw new Error("Expected Slack bot-loop protection facts for a peer bot");
    }
    return guard.recordAndCheck({
      ...facts,
      settings: resolvePairLoopGuardSettings(facts),
    }).suppressed;
  };
}

describe("resolveSlackBotLoopProtection", () => {
  it.each([undefined, 3])(
    "isolates pair cooldowns across channels with conversation budget %s",
    (maxConversationBotEvents) => {
      const record = createAdmission({ maxEventsPerWindow: 2, maxConversationBotEvents });

      expect(record("C_FIRST", "010")).toBe(false);
      expect(record("C_FIRST", "020")).toBe(false);
      expect(record("C_FIRST", "030")).toBe(true);
      expect(record("C_FIRST", "040")).toBe(true);
      // Same account, sender, receiver, thread timestamp and event timestamp:
      // only the channel differs, so the second channel must start unblocked.
      expect(record("C_SECOND", "040")).toBe(false);
      expect(record("C_SECOND", "040")).toBe(false); // Transport retry.
      expect(record("C_SECOND", "050")).toBe(false);
      expect(record("C_SECOND", "060")).toBe(true);
      expect(record("C_SECOND", "070")).toBe(true);
      expect(record("C_SECOND", "070", "B_PEER", "1700000001.001")).toBe(false);
      expect(record("C_SECOND", "070", "B_PEER", null)).toBe(false);
    },
  );

  it.each([undefined, 3])(
    "isolates multi-peer bursts across channels with conversation budget %s",
    (maxConversationBotEvents) => {
      const record = createAdmission({ maxEventsPerWindow: 100, maxConversationBotEvents });
      const burstEnabled = maxConversationBotEvents !== undefined;

      expect(record("C_FIRST", "010", "B_PEER")).toBe(false);
      expect(record("C_FIRST", "020", "B_OTHER")).toBe(false);
      expect(record("C_FIRST", "030", "B_PEER")).toBe(false);
      expect(record("C_FIRST", "040", "B_OTHER")).toBe(burstEnabled);
      expect(record("C_FIRST", "050", "B_THIRD")).toBe(burstEnabled);
      expect(record("C_SECOND", "050", "B_THIRD")).toBe(false);
      expect(record("C_SECOND", "050", "B_THIRD")).toBe(false); // Transport retry.
      expect(record("C_SECOND", "060", "B_OTHER")).toBe(false);
      expect(record("C_SECOND", "070", "B_THIRD")).toBe(false);
      expect(record("C_SECOND", "080", "B_OTHER")).toBe(burstEnabled);
      expect(record("C_SECOND", "090", "B_PEER")).toBe(burstEnabled);
      expect(record("C_SECOND", "090", "B_PEER", "1700000001.001")).toBe(false);
      expect(record("C_SECOND", "090", "B_PEER", null)).toBe(false);
    },
  );

  it("qualifies the thread conversation identity with its channel", () => {
    // Matches buildSlackDebounceKey: a thread ts is unique only inside its channel.
    expect(
      resolveSlackBotLoopProtection(prepared({ channel: "C123", thread_ts: "1700000000.001" }))
        ?.conversationId,
    ).toBe("C123:1700000000.001");
  });

  it("uses the channel for top-level messages", () => {
    expect(resolveSlackBotLoopProtection(prepared({ channel: "C123" }))?.conversationId).toBe(
      "C123",
    );
  });

  it("forwards the stable Slack timestamp as the replay identity", () => {
    expect(
      resolveSlackBotLoopProtection(prepared({ channel: "C123", ts: "1700000000.002" }))?.eventId,
    ).toBe("1700000000.002");
  });
});
