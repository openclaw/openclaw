import type { App } from "@slack/bolt";
import { resolveEnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  afterEach(() => vi.restoreAllMocks());

  type ThreadParams = Parameters<typeof resolveSlackThreadContextData>[0];
  async function resolveAllowlistedThreadContext(
    params: Partial<
      Pick<
        ThreadParams,
        "allowFromLower" | "allowNameMatching" | "isGroupDm" | "roomLabel" | "contextVisibilityMode"
      >
    > & {
      repliesMessages?: Array<Record<string, string>>;
      threadStarter: NonNullable<ThreadParams["threadStarter"]>;
      sessionState?: "missing" | "fresh" | "stale";
      sessionLastInteractionAt?: number;
      sessionUpdatedAt?: number;
      initialHistoryLimit?: number;
      message?: Partial<SlackMessageEvent>;
    },
  ) {
    const { storePath } = storeFixture.makeTmpStorePath();
    const replies = vi.fn().mockResolvedValue({
      messages: params.repliesMessages ?? [],
      response_metadata: { next_cursor: "" },
    });
    const ctx = createInboundSlackTestContext({
      cfg: { channels: { slack: { enabled: true, replyToMode: "all", groupPolicy: "open" } } },
      appClient: { conversations: { replies } } as App["client"],
      defaultRequireMention: false,
      replyToMode: "all",
    });
    if (params.sessionState) {
      ctx.channelRuntime = {
        ...ctx.channelRuntime!,
        session: {
          resolveEntryResetFreshnessAsync: async () =>
            params.sessionState === "missing"
              ? { state: "missing", entry: undefined }
              : {
                  state: params.sessionState,
                  entry: {
                    lastInteractionAt: params.sessionLastInteractionAt,
                    updatedAt: params.sessionUpdatedAt,
                  },
                },
        },
      };
    }
    ctx.botUserId = "U_BOT";
    ctx.botId = "B1";
    ctx.resolveUserName = async (id: string) => ({ name: id === "U1" ? "Alice" : "Mallory" });

    const result = await resolveSlackThreadContextData({
      ctx,
      agentId: "main",
      account: createSlackTestAccount({
        thread: { initialHistoryLimit: params.initialHistoryLimit ?? 20 },
      }),
      message: {
        channel: "C123",
        channel_type: "channel",
        user: "U1",
        text: "current message",
        ts: "101.000",
        thread_ts: "100.000",
        ...params.message,
      },
      isGroupDm: params.isGroupDm ?? false,
      isThreadReply: true,
      threadTs: "100.000",
      threadStarter: params.threadStarter,
      roomLabel: params.roomLabel ?? "#general",
      storePath,
      sessionKey: "thread-session",
      allowFromLower: params.allowFromLower ?? ["u1"],
      allowNameMatching: params.allowNameMatching ?? false,
      contextVisibilityMode: params.contextVisibilityMode ?? "allowlist",
      envelopeOptions: resolveEnvelopeFormatOptions({}),
      effectiveDirectMedia: null,
    });

    return { replies, result };
  }

  const starter = (text: string, userId = "U1") => ({ text, userId, ts: "100.000" });

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
    ["hydrates starter media for a new thread session", "missing", undefined, true],
    ["does not hydrate starter media for an existing thread session", "fresh", 100, false],
    ["hydrates starter media for an outbound-only thread session", "fresh", undefined, true],
  ] as const)("%s", async (_title, sessionState, sessionLastInteractionAt, hydrates) => {
    const resolveSlackAttachmentContent = vi
      .spyOn(mediaModule, "resolveSlackAttachmentContent")
      .mockResolvedValue({ text: "", media: starterMedia, unavailableMediaCount: 0 });
    const { result } = await resolveAllowlistedThreadContext({
      threadStarter: { text: "starter with image", userId: "U1", files: starterFiles },
      sessionState,
      sessionLastInteractionAt,
    });

    expect(result.threadStarterMedia).toEqual(hydrates ? starterMedia : null);
    expect(resolveSlackAttachmentContent).toHaveBeenCalledTimes(hydrates ? 1 : 0);
  });

  it("omits non-allowlisted starter, follow-ups, and unrelated current-bot replies", async () => {
    const { replies, result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "starter secret", user: "U2", ts: "100.000" },
        { text: "assistant reply", bot_id: "B1", ts: "100.500" },
        { text: "blocked follow-up", user: "U2", ts: "100.700" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: starter("starter secret", "U2"),
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

  it.each([
    ["filters them after an inbound MPIM interaction", 100, undefined],
    ["filters them after an explicit MPIM reset", undefined, 0],
  ] as const)("%s", async (_title, sessionLastInteractionAt, sessionUpdatedAt) => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "starter from Alice", user: "U1", ts: "100.000" },
        { text: "assistant progress update", bot_id: "B1", ts: "100.200" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: starter("starter from Alice"),
      sessionState: "stale",
      sessionLastInteractionAt,
      sessionUpdatedAt,
      isGroupDm: true,
    });

    expect(result.threadStarterBody).toBe("starter from Alice");
    expect(result.threadHistoryBody).toContain("starter from Alice");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).not.toContain("assistant progress update");
    expect(result.threadHistoryBody).not.toContain("current message");
  });

  it("keeps the 20-message cap and excludes the current MPIM message", async () => {
    const priorMessages = Array.from({ length: 22 }, (_, index) => ({
      text: index === 20 ? "assistant answer to retain" : `prior user message ${index}`,
      ...(index === 20 ? { bot_id: "B1" } : { user: "U1" }),
      ts: `100.${String(index).padStart(3, "0")}`,
    }));
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [...priorMessages, { text: "current message", user: "U1", ts: "101.000" }],
      threadStarter: starter("prior user message 0"),
      sessionState: "fresh",
      isGroupDm: true,
    });

    const history = result.threadHistoryBody ?? "";
    expect(history.match(/\[slack message id:/g)).toHaveLength(20);
    expect(history).toContain("prior user message 21");
    expect(history).toContain("assistant answer to retain");
    expect(history).toContain("Bot (this assistant) (assistant)");
    expect(history).not.toContain("[slack message id: 100.000 channel: C123]");
    expect(history).not.toContain("[slack message id: 100.001 channel: C123]");
    expect(history).not.toContain("current message");
  });

  it("keeps starter text and history when allowNameMatching authorizes the sender", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "starter from Alice", user: "U1", ts: "100.000" },
        { text: "blocked follow-up", user: "U2", ts: "100.700" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: starter("starter from Alice"),
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
      threadStarter: starter(starterText),
    });

    expect(result.threadLabel).toBe(`Slack thread #general: ${"a".repeat(79)}`);
  });

  it("formats a whitespace bot-root label through thread preparation", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      threadStarter: { text: "   ", botId: "B1", ts: "100.000" },
    });
    expect(result.threadLabel).toBe("Slack thread #general");
  });

  it("injects bot-authored starter when initial history trimming drops the root", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      initialHistoryLimit: 1,
      repliesMessages: [
        { text: "bot starter", bot_id: "B1", ts: "100.000" },
        { text: "old user follow-up", user: "U1", ts: "100.100" },
        { text: "recent user follow-up", user: "U1", ts: "100.900" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: { text: "bot starter", botId: "B1", ts: "100.000" },
    });

    expect(result.threadHistoryBody).toContain("bot starter");
    expect(result.threadHistoryBody).toContain("recent user follow-up");
    expect(result.threadHistoryBody).not.toContain("old user follow-up");
    expect(result.threadHistoryBody).not.toContain("current message");
  });

  it("keeps explicitly allowlisted third-party bot starter text in a new thread session", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "other bot starter", bot_id: "B2", ts: "100.000" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: { text: "other bot starter", botId: "B2", ts: "100.000" },
      allowFromLower: ["u1", "b2"],
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
      threadStarter: starter("starter from Alice"),
    });

    const malformedHistoryEntry = result.threadHistoryBody
      ?.split("\n\n")
      .find((entry) => entry.includes("malformed timestamp follow-up"));
    expect(malformedHistoryEntry).toContain("[slack message id: 0x65 channel: C123]");
    expect(malformedHistoryEntry).not.toContain("1970-01-01");
  });

  it("includes self-authored starter (identified by bot user id) for a new thread session (default)", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        { text: "self starter", user: "U_BOT", ts: "100.000" },
        { text: "allowed follow-up", user: "U1", ts: "100.800" },
        { text: "current message", user: "U1", ts: "101.000" },
      ],
      threadStarter: starter("self starter", "U_BOT"),
    });

    expect(result.threadStarterBody).toBeUndefined();
    expect(result.threadLabel).toBe("Slack thread #general (assistant root): self starter");
    expect(result.threadHistoryBody).toContain("allowed follow-up");
    expect(result.threadHistoryBody).toContain("self starter");
    expect(result.threadHistoryBody).toContain("Bot (this assistant) (assistant)");
  });

  it("issue #79338: bot DM confirmation root is included so reply has parent context", async () => {
    const { result } = await resolveAllowlistedThreadContext({
      repliesMessages: [
        {
          text: "Confirmed Saturday 12:30pm meeting with Alice",
          bot_id: "B1",
          ts: "100.000",
        },
        {
          text: "actually it's Sunday 12:30 pm - apologize and correct",
          user: "U1",
          ts: "101.000",
        },
      ],
      message: {
        channel: "D123",
        channel_type: "im",
        text: "actually it's Sunday 12:30 pm - apologize and correct",
        ts: "101.000",
      },
      threadStarter: {
        text: "Confirmed Saturday 12:30pm meeting with Alice",
        botId: "B1",
        ts: "100.000",
      },
      roomLabel: "DM",
      allowFromLower: [],
      contextVisibilityMode: "all",
    });

    expect(result.threadHistoryBody).toContain("Confirmed Saturday 12:30pm meeting with Alice");
    expect(result.threadHistoryBody).toContain("Bot (this assistant) (assistant)");
    expect(result.threadHistoryBody).not.toContain(
      "actually it's Sunday 12:30 pm - apologize and correct",
    );
    expect(result.threadLabel).toContain("Confirmed Saturday 12:30pm");
  });
});
