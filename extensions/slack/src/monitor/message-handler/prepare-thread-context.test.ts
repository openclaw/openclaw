// Slack tests cover prepare thread context plugin behavior.
import type { App } from "@slack/bolt";
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as runtimeEnv from "openclaw/plugin-sdk/runtime-env";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../types.js";
import * as mediaModule from "../media.js";
import { resolveSlackThreadContextData } from "./prepare-thread-context.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

describe("resolveSlackThreadContextData", () => {
  const storeFixture = createSlackSessionStoreFixture("openclaw-slack-thread-context-");

  beforeAll(() => {
    storeFixture.setup();
  });

  afterAll(() => {
    storeFixture.cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    repliesMessages: Array<Record<string, string | undefined>>;
    threadStarter: {
      text: string;
      userId?: string;
      ts?: string;
      botId?: string;
      files?: NonNullable<SlackMessageEvent["files"]>;
    } | null;
    allowFromLower: string[];
    allowNameMatching: boolean;
    sessionState?: "missing" | "fresh" | "stale";
    sessionLastInteractionAt?: number;
    sessionUpdatedAt?: number;
    isGroupDm?: boolean;
    initialHistoryLimit?: number;
    botIdentity?: { botUserId?: string; botId?: string };
    message?: Partial<SlackMessageEvent>;
    roomLabel?: string;
    contextVisibilityMode?: "all" | "allowlist";
  }) {
    const { storePath } = storeFixture.makeTmpStorePath();
    const replies = vi.fn().mockResolvedValue({
      messages: params.repliesMessages,
      response_metadata: { next_cursor: "" },
    });
    const ctx = createThreadContext({ replies });
    if (params.sessionState) {
      ctx.channelRuntime = {
        ...ctx.channelRuntime!,
        session: {
          resolveEntryResetFreshness: () =>
            params.sessionState === "missing"
              ? { state: "missing", entry: undefined }
              : {
                  state: params.sessionState,
                  entry: {
                    ...(params.sessionLastInteractionAt !== undefined
                      ? { lastInteractionAt: params.sessionLastInteractionAt }
                      : {}),
                    ...(params.sessionUpdatedAt !== undefined
                      ? { updatedAt: params.sessionUpdatedAt }
                      : {}),
                  },
                },
        },
      };
    }
    ctx.botUserId = params.botIdentity ? (params.botIdentity.botUserId ?? "") : "U_BOT";
    ctx.botId = params.botIdentity ? params.botIdentity.botId : "B1";
    ctx.resolveUserName = async (id: string) => ({
      name: id === "U1" ? "Alice" : "Mallory",
    });

    const result = await resolveSlackThreadContextData({
      ctx,
      agentId: "main",
      account: createSlackTestAccount({
        thread: { initialHistoryLimit: params.initialHistoryLimit ?? 20 },
      }),
      message: createThreadMessage(params.message),
      isGroupDm: params.isGroupDm ?? false,
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: params.threadStarter,
      roomLabel: params.roomLabel ?? "#general",
      storePath,
      sessionKey: "thread-session",
      allowFromLower: params.allowFromLower,
      allowNameMatching: params.allowNameMatching,
      contextVisibilityMode: params.contextVisibilityMode ?? "allowlist",
      envelopeOptions: resolveEnvelopeFormatOptions({} as OpenClawConfig),
      effectiveDirectMedia: null,
    });

    return { replies, result };
  }

  const starterFiles = [
    {
      id: "FROOT",
      name: "root.png",
      mimetype: "image/png",
      url_private: "https://files.slack.com/root.png",
    },
  ];
  const starterMedia = [
    {
      path: "/tmp/root.png",
      contentType: "image/png",
      placeholder: "[Slack file: root.png (fileId: FROOT)]",
    },
  ];

  it.each([
    {
      title: "hydrates starter media for a new thread session",
      sessionState: "missing" as const,
      hydrates: true,
    },
    {
      title: "does not hydrate starter media for an existing thread session",
      sessionState: "fresh" as const,
      sessionLastInteractionAt: 100,
      hydrates: false,
    },
    {
      title: "hydrates starter media for an outbound-only thread session",
      sessionState: "fresh" as const,
      hydrates: true,
    },
    {
      title: "hydrates starter media after a thread session reset",
      sessionState: "stale" as const,
      hydrates: true,
    },
  ])("$title", async ({ sessionState, sessionLastInteractionAt, hydrates }) => {
    const resolveSlackAttachmentContent = vi
      .spyOn(mediaModule, "resolveSlackAttachmentContent")
      .mockResolvedValue({
        text: "",
        media: starterMedia,
        unavailableMediaCount: 0,
      });
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [],
      threadStarter: { text: "starter with image", userId: "U1", files: starterFiles },
      allowFromLower: ["u1"],
      allowNameMatching: false,
      sessionState,
      sessionLastInteractionAt,
    });

    expect(result.threadStarterMedia).toEqual(hydrates ? starterMedia : null);
    expect(resolveSlackAttachmentContent).toHaveBeenCalledTimes(hydrates ? 1 : 0);
  });

  it("omits non-allowlisted starter, follow-ups, and unrelated current-bot replies", async () => {
    const logVerbose = vi.spyOn(runtimeEnv, "logVerbose").mockImplementation(() => {});
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
    expect(logVerbose).toHaveBeenCalledWith(
      "slack: omitted 3 thread message(s) from context (mode=allowlist)",
    );
  });

  it.each([
    {
      title: "filters them from missing channel threads",
      isGroupDm: false,
      sessionState: "missing" as const,
      retained: false,
    },
    {
      title: "filters them from fresh outbound-only channel threads",
      isGroupDm: false,
      sessionState: "fresh" as const,
      retained: false,
    },
    {
      title: "filters them from stale outbound-only channel threads",
      isGroupDm: false,
      sessionState: "stale" as const,
      retained: false,
    },
    {
      title: "retains them for missing MPIM threads",
      isGroupDm: true,
      sessionState: "missing" as const,
      retained: true,
    },
    {
      title: "retains them for fresh outbound-only MPIM threads",
      isGroupDm: true,
      sessionState: "fresh" as const,
      retained: true,
    },
    {
      title: "retains them for stale outbound-only MPIM threads",
      isGroupDm: true,
      sessionState: "stale" as const,
      retained: true,
    },
    {
      title: "filters them after an inbound MPIM interaction",
      isGroupDm: true,
      sessionState: "stale" as const,
      sessionLastInteractionAt: 100,
      retained: false,
    },
    {
      title: "filters them after an explicit MPIM reset",
      isGroupDm: true,
      sessionState: "stale" as const,
      sessionUpdatedAt: 0,
      retained: false,
    },
  ])(
    "$title",
    async ({ isGroupDm, sessionState, sessionLastInteractionAt, sessionUpdatedAt, retained }) => {
      const { result } = await resolveAllowlistedThreadContext({
        repliesMessages: [
          { text: "starter from Alice", user: "U1", ts: "100.000" },
          { text: "assistant progress update", bot_id: "B1", ts: "100.200" },
          { text: "self-authored progress update", user: "U_BOT", ts: "100.300" },
          { text: "allowed follow-up", user: "U1", ts: "100.800" },
          { text: "current message", user: "U1", ts: "101.000" },
        ],
        threadStarter: {
          text: "starter from Alice",
          userId: "U1",
          ts: "100.000",
        },
        allowFromLower: ["u1"],
        allowNameMatching: false,
        sessionState,
        sessionLastInteractionAt,
        sessionUpdatedAt,
        isGroupDm,
      });

      expect(result.threadStarterBody).toBe("starter from Alice");
      expect(result.threadHistoryBody).toContain("starter from Alice");
      expect(result.threadHistoryBody).toContain("allowed follow-up");
      if (retained) {
        expect(result.threadHistoryBody).toContain("assistant progress update");
        expect(result.threadHistoryBody).toContain("self-authored progress update");
        expect(result.threadHistoryBody).toContain("Bot (this assistant) (assistant)");
      } else {
        expect(result.threadHistoryBody).not.toContain("assistant progress update");
        expect(result.threadHistoryBody).not.toContain("self-authored progress update");
      }
      expect(result.threadHistoryBody).not.toContain("current message");
    },
  );

  it("keeps the 20-message cap and excludes the current MPIM message", async () => {
    const priorMessages = Array.from({ length: 22 }, (_, index) => ({
      text: index === 20 ? "assistant answer to retain" : `prior user message ${index}`,
      ...(index === 20 ? { bot_id: "B1" } : { user: "U1" }),
      ts: `100.${String(index).padStart(3, "0")}`,
    }));
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [...priorMessages, { text: "current message", user: "U1", ts: "101.000" }],
      threadStarter: {
        text: "prior user message 0",
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
      sessionState: "fresh",
      isGroupDm: true,
    });

    const history = result.threadHistoryBody ?? "";
    expect(history.match(/\[slack message id:/g)).toHaveLength(20);
    expect(history).not.toContain("[slack message id: 100.000 channel: C123]");
    expect(history).not.toContain("[slack message id: 100.001 channel: C123]");
    expect(history).toContain("prior user message 21");
    expect(history).toContain("assistant answer to retain");
    expect(history).toContain("Bot (this assistant) (assistant)");
    expect(history).not.toContain("current message");
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

  it("keeps a user-started thread label UTF-16 safe at the snippet limit", async () => {
    const starterText = `${"a".repeat(79)}🐱tail`;
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [],
      threadStarter: {
        text: starterText,
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadLabel).toBe(`Slack thread #general: ${"a".repeat(79)}`);
  });

  it.each([
    { name: "fetched bot-id root", author: { botId: "B1" }, rootInHistory: true },
    { name: "omitted bot-id root", author: { botId: "B1" }, rootInHistory: false },
    {
      name: "trimmed bot-id root",
      author: { botId: "B1" },
      rootInHistory: true,
      initialHistoryLimit: 1,
    },
    { name: "bot-user root", author: { userId: "U_BOT" }, rootInHistory: true },
    {
      name: "DM confirmation root (#79338)",
      author: { botId: "B1" },
      rootInHistory: true,
      direct: true,
    },
  ])("retains exactly one $name as assistant context", async (testCase) => {
    const starterText = "Confirmed Saturday 12:30pm meeting with Alice";
    const root = {
      text: starterText,
      user: testCase.author.userId,
      bot_id: testCase.author.botId,
      ts: "100.000",
    };
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        ...(testCase.rootInHistory ? [root] : []),
        { text: "old user follow-up", user: "U1", ts: "100.100" },
        { text: "assistant reply", bot_id: "B1", ts: "100.500" },
        { text: "self-authored reply", user: "U_BOT", ts: "100.600" },
        { text: "allowed follow-up", user: "U1", ts: "100.900" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: { text: starterText, ...testCase.author },
      initialHistoryLimit: testCase.initialHistoryLimit,
      message: testCase.direct ? { channel: "D123", channel_type: "im" } : undefined,
      roomLabel: testCase.direct ? "DM" : "#general",
      contextVisibilityMode: testCase.direct ? "all" : "allowlist",
      allowFromLower: testCase.direct ? [] : ["u1"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadLabel).toBe(
      "Slack thread " + (testCase.direct ? "DM" : "#general") + " (assistant root): " + starterText,
    );
    expect(result.threadHistoryBody?.match(/\[slack message id: 100\.000 /g)).toHaveLength(1);
    expect(result.threadHistoryBody).toContain(starterText);
    expect(result.threadHistoryBody).toContain("Bot (this assistant) (assistant)");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("assistant reply");
    expect(result.threadHistoryBody).not.toContain("self-authored reply");
    expect(result.threadHistoryBody).not.toContain("current message");
    if (testCase.initialHistoryLimit === 1) {
      expect(result.threadHistoryBody).not.toContain("old user follow-up");
    }
  });

  it.each([
    { text: "  hello\n  world  ", snippet: "hello world" },
    { text: "x".repeat(120), snippet: "x".repeat(80) },
    { text: "a".repeat(79) + "🐱tail", snippet: "a".repeat(79) },
    { text: "", snippet: undefined },
    { text: "  \n  ", snippet: undefined },
    { text: undefined, snippet: undefined },
  ])("formats bot starter label for $text", async ({ text, snippet }) => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [],
      threadStarter: text === undefined ? null : { text, botId: "B1" },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });
    expect(result.threadLabel).toBe(
      "Slack thread #general" + (snippet ? " (assistant root): " + snippet : ""),
    );
  });

  it.each([
    { botIdentity: {}, botId: undefined, author: "Mallory (user)" },
    { botIdentity: { botUserId: "", botId: "" }, botId: undefined, author: "Mallory (user)" },
    { botIdentity: {}, botId: "B1", author: "Mallory (assistant)" },
    { botIdentity: { botUserId: "", botId: "" }, botId: "B1", author: "Mallory (assistant)" },
  ])(
    "does not treat $author as the current bot without configured identity $botIdentity",
    async ({ botIdentity, botId, author }) => {
      const { result } = await resolveAllowlistedThreadContext({
        botIdentity,
        repliesMessages: [{ text: "starter", user: "U_BOT", bot_id: botId, ts: "100.000" }],
        threadStarter: { text: "starter", userId: "U_BOT", botId, ts: "100.000" },
        allowFromLower: ["u_bot", "b1"],
        allowNameMatching: false,
      });
      expect(result.threadStarterBody).toBe("starter");
      expect(result.threadLabel).toBe("Slack thread #general: starter");
      expect(result.threadHistoryBody).toContain(author);
      expect(result.threadHistoryBody).not.toContain("Bot (this assistant)");
    },
  );

  it("omits current-bot starter context already held by a fresh session", async () => {
    const { replies, result } = await resolveAllowlistedThreadContext({
      repliesMessages: [],
      threadStarter: { text: "bot starter", botId: "B1" },
      sessionState: "fresh",
      sessionLastInteractionAt: 100,
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });
    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadHistoryBody).toBeUndefined();
    expect(result.threadLabel).toBe("Slack thread #general");
    expect(replies).not.toHaveBeenCalled();
  });

  it("keeps explicitly allowlisted third-party bot starter text in a new thread session", async () => {
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
      allowFromLower: ["u1", "b2"],
      allowNameMatching: false,
    });

    expect(result.threadStarterBody).toBe("other bot starter");
    expect(result.threadLabel).toContain("other bot starter");
    expect(result.threadHistoryBody).toContain("other bot starter");
    expect(result.threadHistoryBody).toContain("Bot (B2) (assistant)");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("Unknown (user)");
  });

  it("does not coerce malformed thread history timestamps into event times", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "starter from Alice", user: "U1", ts: "100.000" },
        { text: "malformed timestamp follow-up", user: "U1", ts: "0x65" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: {
        text: "starter from Alice",
        userId: "U1",
        ts: "100.000",
      },
      allowFromLower: ["u1"],
      allowNameMatching: false,
    });

    const malformedHistoryEntry = result.threadHistoryBody
      ?.split("\n\n")
      .find((entry) => entry.includes("malformed timestamp follow-up"));
    expect(malformedHistoryEntry).toContain("[slack message id: 0x65 channel: C123]");
    expect(malformedHistoryEntry).not.toContain("1970-01-01");
  });
});
