import fs from "node:fs";
import type { App } from "@slack/bolt";
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { clearSessionStoreCacheForTest } from "openclaw/plugin-sdk/session-store-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackThreadContextData } from "./prepare-thread-context.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

function seedThreadSessionTimestamp(
  storePath: string,
  sessionKey: string,
  updatedAt: number,
): void {
  seedThreadSessionEntry(storePath, sessionKey, { updatedAt });
}

function seedThreadSessionEntry(
  storePath: string,
  sessionKey: string,
  fields: { updatedAt: number; sessionStartedAt?: number; lastInteractionAt?: number },
): void {
  const normalized = sessionKey.trim().toLowerCase();
  const entry: Record<string, unknown> = {
    sessionId: normalized,
    updatedAt: fields.updatedAt,
  };
  if (fields.sessionStartedAt !== undefined) {
    entry.sessionStartedAt = fields.sessionStartedAt;
  }
  if (fields.lastInteractionAt !== undefined) {
    entry.lastInteractionAt = fields.lastInteractionAt;
  }
  fs.writeFileSync(storePath, JSON.stringify({ [normalized]: entry }, null, 2));
}

describe("resolveSlackThreadContextData", () => {
  const storeFixture = createSlackSessionStoreFixture("openclaw-slack-thread-context-");

  beforeAll(() => {
    storeFixture.setup();
  });

  afterAll(() => {
    storeFixture.cleanup();
  });

  function createThreadContext(params: { replies: unknown }) {
    return createInboundSlackTestContext({
      cfg: {
        channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
      } as OpenClawConfig,
      appClient: { conversations: { replies: params.replies } } as App["client"],
      defaultRequireMention: false,
      replyToMode: "all",
    });
  }

  function createThreadMessage(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
    return {
      channel: "C123",
      channel_type: "channel",
      user: "U1",
      text: "current message",
      ts: "101.000",
      thread_ts: "100.000",
      ...overrides,
    } as SlackMessageEvent;
  }

  async function resolveAllowlistedThreadContext(params: {
    repliesMessages: Array<Record<string, string>>;
    threadStarter: { text: string; userId?: string; ts: string; botId?: string };
    allowFromLower: string[];
    allowNameMatching: boolean;
  }) {
    const { storePath } = storeFixture.makeTmpStorePath();
    const replies = vi.fn().mockResolvedValue({
      messages: params.repliesMessages,
      response_metadata: { next_cursor: "" },
    });
    const ctx = createThreadContext({ replies });
    ctx.botUserId = "U_BOT";
    ctx.botId = "B1";
    ctx.resolveUserName = async (id: string) => ({
      name: id === "U1" ? "Alice" : "Mallory",
    });

    const result = await resolveSlackThreadContextData({
      ctx,
      account: createSlackTestAccount({ thread: { initialHistoryLimit: 20 } }),
      message: createThreadMessage(),
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: params.threadStarter,
      roomLabel: "#general",
      storePath,
      sessionKey: "thread-session",
      allowFromLower: params.allowFromLower,
      allowNameMatching: params.allowNameMatching,
      contextVisibilityMode: "allowlist",
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      effectiveDirectMedia: null,
    });

    return { replies, result };
  }

  it("omits non-allowlisted starter text and thread history messages", async () => {
    const { replies, result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "starter secret", user: "U2", ts: "100.000" },
        { text: "assistant reply", bot_id: "B1", ts: "100.500" },
        { text: "blocked follow-up", user: "U2", ts: "100.700" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "starter secret",
        userId: "U2",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadLabel).toBe("Slack thread #general");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("assistant reply");
    expect(result.threadHistoryBody).not.toContain("starter secret");
    expect(result.threadHistoryBody).not.toContain("blocked follow-up");
    expect(result.threadHistoryBody).not.toContain("current message");
    expect(replies).toHaveBeenCalledTimes(1);
  });

  it("keeps starter text and history when allowNameMatching authorizes the sender", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "starter from Alice", user: "U1", ts: "100.000" },
        { text: "blocked follow-up", user: "U2", ts: "100.700" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "starter from Alice",
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["alice"],
      allowNameMatching: true,
    });

    expect(result.threadStarterBody).toBe("starter from Alice");
    expect(result.threadLabel).toContain("starter from Alice");
    expect(result.threadHistoryBody).toContain("starter from Alice");
    expect(result.threadHistoryBody).not.toContain("blocked follow-up");
  });

  it("omits bot-authored starter text and history from a new thread session", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "bot starter", bot_id: "B1", ts: "100.000" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "bot starter",
        botId: "B1",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadLabel).toBe("Slack thread #general");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("bot starter");
    expect(result.threadHistoryBody).not.toContain("current message");
  });

  it("keeps third-party bot starter text in a new thread session", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "other bot starter", bot_id: "B2", ts: "100.000" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "other bot starter",
        botId: "B2",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBe("other bot starter");
    expect(result.threadLabel).toContain("other bot starter");
    expect(result.threadHistoryBody).toContain("other bot starter");
    expect(result.threadHistoryBody).toContain("Bot (B2) (assistant)");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("Unknown (user)");
  });

  it("omits self-authored starter text when identified by bot user id", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "self starter", user: "U_BOT", ts: "100.000" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "self starter",
        userId: "U_BOT",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("self starter");
  });

  describe("session-freshness gate (#33507)", () => {
    beforeEach(() => {
      clearSessionStoreCacheForTest();
    });

    async function resolveThreadContextWithFreshnessGate(params: {
      seedUpdatedAt?: number;
      seedEntry?: { updatedAt: number; sessionStartedAt?: number; lastInteractionAt?: number };
      now: number;
      cfg: OpenClawConfig;
    }) {
      const { storePath } = storeFixture.makeTmpStorePath();
      if (params.seedEntry) {
        seedThreadSessionEntry(storePath, "thread-session", params.seedEntry);
      } else if (params.seedUpdatedAt !== undefined) {
        seedThreadSessionTimestamp(storePath, "thread-session", params.seedUpdatedAt);
      }
      const replies = vi.fn().mockResolvedValue({
        messages: [
          { text: "old message", user: "U1", ts: "100.000" },
          { text: "current message", user: "U1", ts: "101.000" },
        ],
        response_metadata: { next_cursor: "" },
      });
      const ctx = createInboundSlackTestContext({
        cfg: params.cfg,
        appClient: { conversations: { replies } } as unknown as App["client"],
        defaultRequireMention: false,
        replyToMode: "all",
      });
      ctx.botUserId = "U_BOT";
      ctx.botId = "B1";
      ctx.resolveUserName = async (id: string) => ({ name: id === "U1" ? "Alice" : undefined });

      const result = await resolveSlackThreadContextData({
        ctx,
        account: createSlackTestAccount({ thread: { initialHistoryLimit: 20 } }),
        message: createThreadMessage(),
        isThreadReply: true,
        threadTs: "100.000",
        threadStarter: null,
        roomLabel: "#general",
        storePath,
        sessionKey: "thread-session",
        allowFromLower: ["u1"],
        allowNameMatching: false,
        contextVisibilityMode: "allowlist",
        envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
        effectiveDirectMedia: null,
        cfg: params.cfg,
        now: params.now,
      });

      return { replies, result };
    }

    it("loads thread history when no prior session timestamp exists (truly new session)", async () => {
      const { replies, result } = await resolveThreadContextWithFreshnessGate({
        // no seed → readSessionUpdatedAt returns undefined
        now: Date.UTC(2026, 3, 27, 12),
        cfg: {
          channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
        } as OpenClawConfig,
      });

      expect(replies).toHaveBeenCalledTimes(1);
      expect(result.threadHistoryBody).toBeDefined();
    });

    it("loads thread history when prior session is stale by idle timeout (#33507)", async () => {
      const now = Date.UTC(2026, 3, 27, 12);
      const updatedAt = now - 10 * 60_000; // 10 minutes ago
      const { replies, result } = await resolveThreadContextWithFreshnessGate({
        seedUpdatedAt: updatedAt,
        now,
        cfg: {
          channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
          session: { reset: { mode: "idle", idleMinutes: 1 } },
        } as OpenClawConfig,
      });

      expect(replies).toHaveBeenCalledTimes(1);
      expect(result.threadHistoryBody).toBeDefined();
      expect(result.threadSessionPreviousTimestamp).toBe(updatedAt);
    });

    it("loads thread history when prior session is stale by daily reset (#33507)", async () => {
      const now = Date.UTC(2026, 3, 27, 12); // 12:00 UTC
      const updatedAt = Date.UTC(2026, 3, 26, 12); // 24h before, prior to today's 04:00 reset
      const { replies, result } = await resolveThreadContextWithFreshnessGate({
        seedUpdatedAt: updatedAt,
        now,
        cfg: {
          channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
          session: { reset: { mode: "daily", atHour: 4 } },
        } as OpenClawConfig,
      });

      expect(replies).toHaveBeenCalledTimes(1);
      expect(result.threadHistoryBody).toBeDefined();
    });

    it("skips thread history when prior session is fresh within the idle window", async () => {
      const now = Date.UTC(2026, 3, 27, 12);
      const updatedAt = now - 30_000; // 30 seconds ago
      const { replies, result } = await resolveThreadContextWithFreshnessGate({
        seedUpdatedAt: updatedAt,
        now,
        cfg: {
          channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
          session: { reset: { mode: "idle", idleMinutes: 5 } },
        } as OpenClawConfig,
      });

      expect(replies).not.toHaveBeenCalled();
      expect(result.threadHistoryBody).toBeUndefined();
      expect(result.threadSessionPreviousTimestamp).toBe(updatedAt);
    });

    it("loads thread history when sessionStartedAt is past daily-reset boundary even if updatedAt is fresh", async () => {
      // Session was started >24h ago and crossed today's 04:00 reset, but
      // updatedAt is recent (within minutes). evaluateSessionFreshness must
      // see sessionStartedAt to detect the daily reset; updatedAt-only would
      // miss it and skip thread history while initSessionState resets the
      // transcript.
      const now = Date.UTC(2026, 3, 27, 12);
      const sessionStartedAt = Date.UTC(2026, 3, 26, 12); // 24h before, prior to today's 04:00 reset
      const updatedAt = now - 30_000; // 30 seconds ago — looks fresh on updatedAt alone
      const { replies, result } = await resolveThreadContextWithFreshnessGate({
        seedEntry: { updatedAt, sessionStartedAt },
        now,
        cfg: {
          channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
          session: { reset: { mode: "daily", atHour: 4 } },
        } as OpenClawConfig,
      });

      expect(replies).toHaveBeenCalledTimes(1);
      expect(result.threadHistoryBody).toBeDefined();
      expect(result.threadSessionPreviousTimestamp).toBe(updatedAt);
    });

    it("loads thread history when lastInteractionAt is past idle boundary even if updatedAt is fresh", async () => {
      // lastInteractionAt is past the idle-reset window but updatedAt was
      // touched recently by metadata writes. The freshness check must see
      // lastInteractionAt to trigger the idle reset.
      const now = Date.UTC(2026, 3, 27, 12);
      const lastInteractionAt = now - 10 * 60_000; // 10 minutes ago
      const updatedAt = now - 30_000; // 30 seconds ago — looks fresh on updatedAt alone
      const { replies, result } = await resolveThreadContextWithFreshnessGate({
        seedEntry: { updatedAt, lastInteractionAt },
        now,
        cfg: {
          channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } },
          session: { reset: { mode: "idle", idleMinutes: 1 } },
        } as OpenClawConfig,
      });

      expect(replies).toHaveBeenCalledTimes(1);
      expect(result.threadHistoryBody).toBeDefined();
      expect(result.threadSessionPreviousTimestamp).toBe(updatedAt);
    });
  });
});
