import {
  createPairLoopGuard,
  resolvePairLoopGuardSettings,
  type PairLoopGuardConfig,
} from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import { describe, expect, it } from "vitest";
import { resolveSlackBotLoopProtection } from "./dispatch-helpers.js";
import type { PreparedSlackMessage } from "./types.js";

/** The three layers an effective burst setting can come from, broad to narrow. */
type GuardConfigs = {
  defaults?: PairLoopGuardConfig;
  account?: PairLoopGuardConfig;
  channel?: PairLoopGuardConfig;
};

function prepared(
  message: {
    channel: string;
    thread_ts?: string;
    ts?: string;
    bot_id?: string;
  },
  configs: GuardConfigs = {},
): PreparedSlackMessage {
  return {
    message: { type: "message", bot_id: "B_PEER", ...message },
    ctx: {
      botId: "B_SELF",
      botUserId: "U_SELF",
      cfg: configs.defaults
        ? { channels: { defaults: { botLoopProtection: configs.defaults } } }
        : {},
    },
    route: { accountId: "default" },
    account: { config: configs.account ? { botLoopProtection: configs.account } : {} },
    channelConfig: configs.channel ? { botLoopProtection: configs.channel } : null,
  } as unknown as PreparedSlackMessage;
}

function createAdmission(configs: GuardConfigs) {
  const guard = createPairLoopGuard();
  return (
    channel: string,
    timestampFraction: string,
    senderBotId = "B_PEER",
    threadTs: string | null = "1700000000.001",
  ): boolean => {
    const event = prepared(
      {
        channel,
        bot_id: senderBotId,
        ts: `1700000000.${timestampFraction}`,
        ...(threadTs === null ? {} : { thread_ts: threadTs }),
      },
      configs,
    );
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

function conversationIdFor(configs: GuardConfigs, threadTs?: string): string | undefined {
  return resolveSlackBotLoopProtection(
    prepared({ channel: "C123", ...(threadTs ? { thread_ts: threadTs } : {}) }, configs),
  )?.conversationId;
}

// Every row leaves the EFFECTIVE conversation burst budget absent, so Slack must
// keep the channel-wide pair accounting that v2026.9.3 and current main ship.
// The runtime accepts only positive integers up to 500, so an out-of-range
// configured value is absent too - a bare `!== undefined` check on the
// configured field would wrongly read those rows as opted in.
const BURST_ABSENT: ReadonlyArray<[string, GuardConfigs]> = [
  ["no burst configuration anywhere", { account: { maxEventsPerWindow: 2 } }],
  [
    "an account burst limit of zero",
    { account: { maxEventsPerWindow: 2, maxConversationBotEvents: 0 } },
  ],
  [
    "an account burst limit above the accepted range",
    { account: { maxEventsPerWindow: 2, maxConversationBotEvents: 501 } },
  ],
  [
    "a channel burst override of zero",
    { account: { maxEventsPerWindow: 2 }, channel: { maxConversationBotEvents: 0 } },
  ],
  [
    "a shared default burst limit above the accepted range",
    { account: { maxEventsPerWindow: 2 }, defaults: { maxConversationBotEvents: 501 } },
  ],
];

// Every row resolves to an effective burst budget of 50 - high enough that the
// conversation budget itself never trips, so the observed difference is purely
// the opt-in switch from channel-wide to thread-scoped pair accounting.
const BURST_PRESENT: ReadonlyArray<[string, GuardConfigs]> = [
  ["an account setting", { account: { maxEventsPerWindow: 2, maxConversationBotEvents: 50 } }],
  [
    "a channel override",
    { account: { maxEventsPerWindow: 2 }, channel: { maxConversationBotEvents: 50 } },
  ],
  [
    "a shared default",
    { account: { maxEventsPerWindow: 2 }, defaults: { maxConversationBotEvents: 50 } },
  ],
  [
    "a channel override above an out-of-range account value",
    {
      account: { maxEventsPerWindow: 2, maxConversationBotEvents: 501 },
      channel: { maxConversationBotEvents: 50 },
    },
  ],
  [
    "a shared default under a rejected account value",
    {
      account: { maxEventsPerWindow: 2, maxConversationBotEvents: 0 },
      defaults: { maxConversationBotEvents: 50 },
    },
  ],
];

describe("resolveSlackBotLoopProtection", () => {
  it.each([undefined, 3])(
    "isolates pair cooldowns across channels with conversation budget %s",
    (maxConversationBotEvents) => {
      const record = createAdmission({
        account: { maxEventsPerWindow: 2, maxConversationBotEvents },
      });
      const burstEnabled = maxConversationBotEvents !== undefined;

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
      // Another thread escapes the channel's cooldown only when the operator
      // opted into thread-scoped accounting by setting the burst budget.
      expect(record("C_SECOND", "070", "B_PEER", "1700000001.001")).toBe(!burstEnabled);
      expect(record("C_SECOND", "070", "B_PEER", null)).toBe(!burstEnabled);
    },
  );

  it.each([undefined, 3])(
    "isolates multi-peer bursts across channels with conversation budget %s",
    (maxConversationBotEvents) => {
      const record = createAdmission({
        account: { maxEventsPerWindow: 100, maxConversationBotEvents },
      });
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

  it("forwards the stable Slack timestamp as the replay identity", () => {
    expect(
      resolveSlackBotLoopProtection(prepared({ channel: "C123", ts: "1700000000.002" }))?.eventId,
    ).toBe("1700000000.002");
  });
});

describe("resolveSlackBotLoopProtection conversation scope", () => {
  // The upgrade contract: an installation that never set maxConversationBotEvents
  // must keep the shipped channel-wide budget. v2026.9.3 and current main suppress
  // the third unique message under a pair limit of two, across threads included.
  it.each(BURST_ABSENT)(
    "keeps channel-wide pair accounting across threads with %s",
    (_label, configs) => {
      const record = createAdmission(configs);

      expect(record("C_UPGRADE", "010", "B_PEER", "1700000000.100")).toBe(false);
      expect(record("C_UPGRADE", "020", "B_PEER", "1700000000.100")).toBe(false);
      // Third unique message, different thread, same channel: still suppressed.
      expect(record("C_UPGRADE", "030", "B_PEER", "1700000000.200")).toBe(true);
    },
  );

  it.each(BURST_ABSENT)(
    "uses the bare channel conversation identity with %s",
    (_label, configs) => {
      expect(conversationIdFor(configs, "1700000000.001")).toBe("C123");
    },
  );

  it.each(BURST_PRESENT)(
    "scopes pair accounting to the thread when the burst budget resolves from %s",
    (_label, configs) => {
      const record = createAdmission(configs);

      expect(record("C_OPTIN", "010", "B_PEER", "1700000000.100")).toBe(false);
      expect(record("C_OPTIN", "020", "B_PEER", "1700000000.100")).toBe(false);
      // Opted in: the other thread carries its own pair budget.
      expect(record("C_OPTIN", "030", "B_PEER", "1700000000.200")).toBe(false);
      // The first thread's own budget is still enforced.
      expect(record("C_OPTIN", "040", "B_PEER", "1700000000.100")).toBe(true);
    },
  );

  it.each(BURST_PRESENT)(
    "qualifies the thread conversation identity with its channel for %s",
    (_label, configs) => {
      // Matches buildSlackDebounceKey: a thread ts is unique only inside its channel.
      expect(conversationIdFor(configs, "1700000000.001")).toBe("C123:1700000000.001");
    },
  );

  it.each([...BURST_ABSENT, ...BURST_PRESENT])(
    "uses the channel for top-level messages with %s",
    (_label, configs) => {
      expect(conversationIdFor(configs)).toBe("C123");
    },
  );
});
