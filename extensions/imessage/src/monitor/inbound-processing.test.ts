import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadFreshIMessageReplyCacheForTest } from "../test-support/runtime.js";
import {
  createInboundDecisionParams,
  type InboundDecisionParams,
} from "./inbound-decision.test-support.js";
import { createSelfChatCache } from "./self-chat-cache.js";

type ReplyCacheModule = typeof import("../monitor-reply-cache.js");
type InboundProcessingModule = typeof import("./inbound-processing.js");
let rememberIMessageReplyCache: ReplyCacheModule["rememberIMessageReplyCache"];
let buildIMessageInboundContext: InboundProcessingModule["buildIMessageInboundContext"];
let resolveIMessageReactionContext: InboundProcessingModule["resolveIMessageReactionContext"];
let resolveIMessageInboundDecision: InboundProcessingModule["resolveIMessageInboundDecision"];
const cfg = {} as OpenClawConfig;
type EchoHas = NonNullable<InboundDecisionParams["echoCache"]>["has"];

beforeAll(async () => {
  ({ rememberIMessageReplyCache } = await loadFreshIMessageReplyCacheForTest());
  ({ buildIMessageInboundContext, resolveIMessageReactionContext, resolveIMessageInboundDecision } =
    await import("./inbound-processing.js"));
});

function resolveDecision(overrides: Parameters<typeof createInboundDecisionParams>[0] = {}) {
  return resolveIMessageInboundDecision(createInboundDecisionParams(overrides));
}

async function buildContext(
  message: InboundDecisionParams["message"],
  overrides: Partial<Parameters<typeof buildIMessageInboundContext>[0]> & {
    agentBodyText?: string;
  } = {},
) {
  const { agentBodyText, ...contextOverrides } = overrides;
  const decision = overrides.decision ?? (await resolveDecision({ message }));
  expect(decision.kind).toBe("dispatch");
  if (decision.kind !== "dispatch") {
    throw new Error("expected dispatch decision");
  }
  return buildIMessageInboundContext({
    cfg,
    accountService: undefined,
    decision: { ...decision, agentBodyText: agentBodyText ?? decision.agentBodyText },
    message,
    historyLimit: 0,
    groupHistories: new Map(),
    ...contextOverrides,
  });
}

const directMessage = (id: number, text: string, guid?: string) => ({
  id,
  text,
  guid,
  sender: "+15555550123",
  is_from_me: false,
  is_group: false,
});

describe("resolveIMessageInboundDecision echo detection", () => {
  it("drops inbound messages when outbound message id matches echo cache", async () => {
    const echoHas = vi.fn<EchoHas>((_scope, lookup) => lookup.messageId === "42");
    const logVerbose = vi.fn();

    const decision = await resolveDecision({
      message: { text: "Reasoning:\n_step_" },
      echoCache: { has: echoHas },
      logVerbose,
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
    expect(echoHas).toHaveBeenNthCalledWith(1, "default:imessage:+15555550123", {
      messageId: "42",
    });
    expect(echoHas).toHaveBeenCalledTimes(1);
    expect(logVerbose).toHaveBeenCalledWith(expect.stringContaining("id=42"));
    expect(logVerbose.mock.calls.flat().join("\n")).not.toContain("Reasoning:");
  });

  it("matches attachment-only echoes by structured media fact", async () => {
    const echoHas = vi.fn<EchoHas>(
      (_scope, lookup) => lookup.media?.kind === "image" && lookup.messageId === "42",
    );

    const decision = await resolveDecision({
      message: { text: "" },
      mediaFacts: [{ contentType: "image/png", kind: "image" }],
      echoCache: { has: echoHas },
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
    expect(echoHas).toHaveBeenNthCalledWith(1, "default:imessage:+15555550123", {
      messageId: "42",
    });
    expect(echoHas).toHaveBeenNthCalledWith(
      2,
      "default:imessage:+15555550123",
      {
        text: undefined,
        media: { contentType: "image/png", kind: "image" },
        messageId: "42",
      },
      {
        includePendingText: false,
        skipIdShortCircuit: undefined,
      },
    );
  });

  it("keeps self-chat cache scoped to configured group threads", async () => {
    const selfChatCache = createSelfChatCache();
    const groupedCfg = {
      channels: { imessage: { groups: { "123": {}, "456": {} } } },
    } as OpenClawConfig;
    const resolveGroup = (id: number, chat_id: number, is_from_me = false) =>
      resolveDecision({
        cfg: groupedCfg,
        message: {
          id,
          chat_id,
          is_from_me,
          text: "same text",
          created_at: "2026-03-02T20:58:10.649Z",
        },
        selfChatCache,
      });

    expect(await resolveGroup(9701, 123, true)).toEqual({ kind: "drop", reason: "from me" });
    const decision = await resolveGroup(9702, 456);
    expect(decision.kind).toBe("dispatch");
  });

  it("does not drop a group inbound when echo cache holds an unrelated chat_guid", async () => {
    const echoHas = vi.fn<EchoHas>(
      (scope, lookup) =>
        scope === "default:chat_guid:iMessage;+;OTHER" && lookup.messageId === "9001",
    );

    const decision = await resolveDecision({
      message: {
        id: 9001,
        chat_id: 42,
        chat_guid: "iMessage;+;chat0000",
        chat_identifier: "chat0000",
        text: "fresh inbound",
        is_group: true,
      },
      echoCache: { has: echoHas },
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("logs reflected duplicate drops without message content", async () => {
    const selfChatCache = createSelfChatCache();
    const logVerbose = vi.fn();
    const bodyText = "line-1\nline-2\t\u001b[31mred";
    const resolveReflection = (message: Partial<InboundDecisionParams["message"]>) =>
      resolveDecision({
        selfChatCache,
        logVerbose,
        message: {
          chat_identifier: "+15555550123",
          text: bodyText,
          created_at: "2026-03-02T20:58:10.649Z",
          ...message,
        },
      });
    await resolveReflection({
      id: 9801,
      destination_caller_id: "+15555550123",
      is_from_me: true,
    });
    const reflection = await resolveReflection({ id: 9802 });
    expect(reflection).toEqual({ kind: "drop", reason: "self-chat echo" });
    expect(logVerbose).toHaveBeenCalledWith("imessage: dropping self-chat reflected duplicate");
    expect(logVerbose.mock.calls.flat().join("\n")).not.toContain("line-1");
  });

  it("returns a reaction decision for tapbacks on bot-authored messages by default", async () => {
    const echoHas = vi.fn<EchoHas>((_scope, lookup) => lookup.messageId === "target-guid");

    const decision = await resolveDecision({
      message: {
        guid: "reaction-guid",
        is_reaction: true,
        reaction_emoji: "👍",
        is_reaction_add: true,
        reacted_to_guid: "target-guid",
        text: "",
      },
      echoCache: { has: echoHas },
    });

    expect(decision).toMatchObject({
      kind: "reaction",
      text: "iMessage reaction added: 👍 by +15555550123 on msg target-guid",
      route: { sessionKey: "agent:main:main" },
      contextKey: expect.stringContaining("imessage:reaction:added"),
    });
  });

  it("dispatches ordinary quoted prose instead of dropping it as a tapback", async () => {
    const text = "Loved “Dune” and the soundtrack was incredible";
    const decision = await resolveDecision({ message: { text } });
    expect(decision.kind).toBe("dispatch");
  });

  it("uses the production reply-cache lookup for bot-authored reaction targets", async () => {
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "p:0/imsg-production",
      chatGuid: "any;-;+15555550123",
      chatIdentifier: "+15555550123",
      chatId: 3,
      timestamp: Date.now(),
      isFromMe: true,
    });

    const decision = await resolveDecision({
      message: {
        guid: "reaction-guid",
        is_reaction: true,
        reaction_emoji: "❤️",
        is_reaction_add: true,
        associated_message_guid: "p:0/imsg-production",
        associated_message_type: 2000,
        text: "Loved “tapback target”",
        chat_id: 3,
        chat_guid: "any;-;+15555550123",
        chat_identifier: "+15555550123",
      },
      echoCache: { has: () => false },
      isKnownFromMeMessageId: undefined,
    });

    expect(decision).toMatchObject({
      kind: "reaction",
      text: "iMessage reaction added: ❤️ by +15555550123 on msg imsg-production",
    });
  });

  it("drops tapbacks on non-bot messages in own notification mode", async () => {
    const decision = await resolveDecision({
      message: {
        is_reaction: true,
        reaction_emoji: "❤️",
        reacted_to_guid: "someone-else",
        text: "",
      },
      echoCache: { has: () => false },
    });

    expect(decision).toEqual({ kind: "drop", reason: "reaction target not sent by agent" });
  });

  it("drops tapbacks when reaction notifications are off", async () => {
    const decision = await resolveDecision({
      reactionNotifications: "off",
      message: {
        is_reaction: true,
        reaction_emoji: "👍",
        reacted_to_guid: "target-guid",
        text: "",
      },
    });

    expect(decision).toEqual({ kind: "drop", reason: "reaction notifications disabled" });
  });
});

describe("resolveIMessageReactionContext", () => {
  it("detects legacy tapback text without treating normal prose as a reaction", async () => {
    expect(resolveIMessageReactionContext({}, "Loved “Hello”")).toStrictEqual({
      action: "added",
      emoji: "❤️",
      targetText: "Hello",
    });
    expect(resolveIMessageReactionContext({}, "Loved the movie")).toBeNull();
  });

  it("detects imsg tapback flags and associated message types", async () => {
    const guid = "321D6826-1013-4DF0-B53C-6F6241EF2EF6";
    expect(
      resolveIMessageReactionContext(
        { is_tapback: true, reaction_emoji: "👍", reacted_to_guid: "target" },
        "",
      ),
    ).toStrictEqual({
      action: "added",
      emoji: "👍",
      targetGuid: "target",
      targetGuids: ["target"],
    });
    expect(
      resolveIMessageReactionContext(
        {
          associated_message_guid: `p:0/${guid}`,
          associated_message_type: 2000,
          reaction_emoji: "❤️",
        },
        "Loved “tapback proof”",
      ),
    ).toStrictEqual({
      action: "added",
      emoji: "❤️",
      targetGuid: guid,
      targetGuids: [guid, `p:0/${guid}`],
    });
    expect(resolveIMessageReactionContext({ associated_message_type: 2001 }, "")).toStrictEqual({
      action: "added",
      emoji: "reaction",
      targetGuid: undefined,
      targetGuids: [],
    });
    expect(resolveIMessageReactionContext({ associated_message_type: 1 }, "ok")).toBeNull();
  });
});

describe("buildIMessageInboundContext", () => {
  it("keeps generated media notices out of command input", async () => {
    const { ctxPayload } = await buildContext(
      directMessage(12347, "/reset", "p:0/GUID-media-failure"),
      {
        agentBodyText: "/reset\n\n[imessage attachment unavailable]",
      },
    );
    expect(ctxPayload).toMatchObject({
      RawBody: "/reset",
      CommandBody: "/reset",
      BodyForAgent: "/reset\n\n[imessage attachment unavailable]",
    });
    expect(ctxPayload.Body).toContain("/reset\n\n[imessage attachment unavailable]");
  });

  it("prepends direct-message history when supplied", async () => {
    const { ctxPayload, inboundHistory } = await buildContext(
      directMessage(12346, "current", "p:0/GUID-current-history"),
      {
        dmHistory: {
          body: "[iMessage from +15555550123]\nprevious\n[/iMessage]",
          inboundHistory: [{ sender: "+15555550123", body: "previous" }],
        },
      },
    );

    expect(ctxPayload.Body).toContain("previous");
    expect(ctxPayload.Body).toContain("current");
    expect(ctxPayload.InboundHistory).toEqual([{ sender: "+15555550123", body: "previous" }]);
    expect(inboundHistory).toEqual([{ sender: "+15555550123", body: "previous" }]);
  });

  it("uses the monitor's prepared account service without re-reading channel config", async () => {
    let channelConfigReads = 0;
    const projectionCfg = Object.defineProperty({}, "channels", {
      enumerable: true,
      get: () => {
        channelConfigReads += 1;
        return { imessage: { service: "imessage" } };
      },
    }) as OpenClawConfig;
    const { ctxPayload, imessageTo } = await buildContext(directMessage(12348, "current"), {
      cfg: projectionCfg,
      accountService: "sms",
    });

    expect(ctxPayload.MessageSid).toBeUndefined();
    expect(imessageTo).toBe("sms:+15555550123");
    expect(channelConfigReads).toBe(0);
  });
});
