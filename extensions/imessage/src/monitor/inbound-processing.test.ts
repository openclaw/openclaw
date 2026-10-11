import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadFreshIMessageReplyCacheForTest } from "../test-support/runtime.js";
import { createSelfChatCache } from "./self-chat-cache.js";

type ReplyCacheModule = typeof import("../monitor-reply-cache.js");
type InboundProcessingModule = typeof import("./inbound-processing.js");
let rememberIMessageReplyCache: ReplyCacheModule["rememberIMessageReplyCache"];
let buildIMessageInboundContext: InboundProcessingModule["buildIMessageInboundContext"];
let resolveIMessageReactionContext: InboundProcessingModule["resolveIMessageReactionContext"];
let resolveIMessageInboundDecision: InboundProcessingModule["resolveIMessageInboundDecision"];
const cfg = {} as OpenClawConfig;
type InboundDecisionParams = Parameters<
  InboundProcessingModule["resolveIMessageInboundDecision"]
>[0];

beforeAll(async () => {
  ({ rememberIMessageReplyCache } = await loadFreshIMessageReplyCacheForTest());
  ({ buildIMessageInboundContext, resolveIMessageReactionContext, resolveIMessageInboundDecision } =
    await import("./inbound-processing.js"));
});

function createInboundDecisionParams(
  overrides: Omit<Partial<InboundDecisionParams>, "message"> & {
    message?: Partial<InboundDecisionParams["message"]>;
  } = {},
): InboundDecisionParams {
  const { message: messageOverrides, ...restOverrides } = overrides;
  const message = {
    id: 42,
    sender: "+15555550123",
    text: "ok",
    is_from_me: false,
    is_group: false,
    ...messageOverrides,
  };
  const messageText = restOverrides.messageText ?? message.text ?? "";
  const bodyText = restOverrides.bodyText ?? messageText;
  return {
    cfg,
    accountId: "default",
    opts: undefined,
    allowFrom: ["*"],
    groupAllowFrom: [],
    groupPolicy: "open",
    dmPolicy: "open",
    storeAllowFrom: [],
    historyLimit: 0,
    groupHistories: new Map(),
    echoCache: undefined,
    selfChatCache: undefined,
    isKnownFromMeMessageId: () => false,
    logVerbose: undefined,
    ...restOverrides,
    message,
    messageText,
    bodyText,
  };
}

function resolveDecision(overrides: Parameters<typeof createInboundDecisionParams>[0] = {}) {
  return resolveIMessageInboundDecision(createInboundDecisionParams(overrides));
}

describe("resolveIMessageInboundDecision echo detection", () => {
  it("drops inbound messages when outbound message id matches echo cache", async () => {
    const echoHas = vi.fn((_scope: string, lookup: { text?: string; messageId?: string }) => {
      return lookup.messageId === "42";
    });
    const logVerbose = vi.fn();

    const decision = await resolveDecision({
      message: {
        id: 42,
        text: "Reasoning:\n_step_",
      },
      messageText: "Reasoning:\n_step_",
      bodyText: "Reasoning:\n_step_",
      echoCache: { has: echoHas },
      logVerbose,
    });

    expect(decision).toEqual({ kind: "drop", reason: "echo" });
    expect(echoHas).toHaveBeenNthCalledWith(1, "default:imessage:+15555550123", {
      messageId: "42",
    });
    expect(echoHas).toHaveBeenCalledTimes(1);
    expect(logVerbose).toHaveBeenCalledWith(expect.stringContaining("id=42"));
  });

  it("matches attachment-only echoes by structured media fact", async () => {
    const echoHas = vi.fn(
      (
        _scope: string,
        lookup: { text?: string; media?: { kind?: string | null }; messageId?: string },
      ) => {
        return lookup.media?.kind === "image" && lookup.messageId === "42";
      },
    );

    const decision = await resolveDecision({
      message: {
        id: 42,
        text: "",
      },
      messageText: "",
      bodyText: "",
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
      channels: {
        imessage: {
          groups: {
            "123": {},
            "456": {},
          },
        },
      },
    } as OpenClawConfig;
    const createdAt = "2026-03-02T20:58:10.649Z";

    expect(
      await resolveDecision({
        cfg: groupedCfg,
        message: {
          id: 9701,
          chat_id: 123,
          text: "same text",
          created_at: createdAt,
          is_from_me: true,
        },
        selfChatCache,
      }),
    ).toEqual({ kind: "drop", reason: "from me" });

    const decision = await resolveDecision({
      cfg: groupedCfg,
      message: {
        id: 9702,
        chat_id: 456,
        text: "same text",
        created_at: createdAt,
      },
      selfChatCache,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("does not drop a group inbound when echo cache holds an unrelated chat_guid", async () => {
    const echoHas = vi.fn(
      (scope: string, lookup: { text?: string; messageId?: string }) =>
        scope === "default:chat_guid:iMessage;+;OTHER" && lookup.messageId === "9001",
    );

    const decision = await resolveDecision({
      message: {
        id: 9001,
        chat_id: 42,
        chat_guid: "iMessage;+;chat0000",
        chat_identifier: "chat0000",
        sender: "+15555550123",
        text: "fresh inbound",
        is_group: true,
      },
      messageText: "fresh inbound",
      bodyText: "fresh inbound",
      echoCache: { has: echoHas },
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("sanitizes reflected duplicate previews before logging", async () => {
    const selfChatCache = createSelfChatCache();
    const logVerbose = vi.fn();
    const createdAt = "2026-03-02T20:58:10.649Z";
    const bodyText = "line-1\nline-2\t\u001b[31mred";

    await resolveDecision({
      message: {
        id: 9801,
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        destination_caller_id: "+15555550123",
        text: bodyText,
        created_at: createdAt,
        is_from_me: true,
      },
      messageText: bodyText,
      bodyText,
      selfChatCache,
      logVerbose,
    });

    await resolveDecision({
      message: {
        id: 9802,
        sender: "+15555550123",
        chat_identifier: "+15555550123",
        text: bodyText,
        created_at: createdAt,
      },
      messageText: bodyText,
      bodyText,
      selfChatCache,
      logVerbose,
    });

    expect(logVerbose).toHaveBeenCalledWith(
      `imessage: dropping self-chat reflected duplicate: "${sanitizeTerminalText(bodyText)}"`,
    );
  });

  it("returns a reaction decision for tapbacks on bot-authored messages by default", async () => {
    const echoHas = vi.fn((_scope: string, lookup: { text?: string; messageId?: string }) => {
      return lookup.messageId === "target-guid";
    });

    const decision = await resolveDecision({
      message: {
        guid: "reaction-guid",
        is_reaction: true,
        reaction_emoji: "👍",
        is_reaction_add: true,
        reacted_to_guid: "target-guid",
        text: "",
      },
      messageText: "",
      bodyText: "",
      echoCache: { has: echoHas },
    });

    expect(decision.kind).toBe("reaction");
    if (decision.kind !== "reaction") {
      throw new Error("expected reaction decision");
    }
    expect(decision.text).toBe("iMessage reaction added: 👍 by +15555550123 on msg target-guid");
    expect(decision.route.sessionKey).toBe("agent:main:main");
    expect(decision.contextKey).toContain("imessage:reaction:added");
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
      messageText: "Loved “tapback target”",
      bodyText: "Loved “tapback target”",
      echoCache: { has: () => false },
      isKnownFromMeMessageId: undefined,
    });

    expect(decision.kind).toBe("reaction");
    if (decision.kind !== "reaction") {
      throw new Error("expected reaction decision");
    }
    expect(decision.text).toBe(
      "iMessage reaction added: ❤️ by +15555550123 on msg imsg-production",
    );
  });

  it("drops tapbacks on non-bot messages in own notification mode", async () => {
    const decision = await resolveDecision({
      message: {
        is_reaction: true,
        reaction_emoji: "❤️",
        reacted_to_guid: "someone-else",
        text: "",
      },
      messageText: "",
      bodyText: "",
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
      messageText: "",
      bodyText: "",
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
          associated_message_guid: "p:0/321D6826-1013-4DF0-B53C-6F6241EF2EF6",
          associated_message_type: 2000,
          reaction_emoji: "❤️",
        },
        "Loved “tapback proof”",
      ),
    ).toStrictEqual({
      action: "added",
      emoji: "❤️",
      targetGuid: "321D6826-1013-4DF0-B53C-6F6241EF2EF6",
      targetGuids: [
        "321D6826-1013-4DF0-B53C-6F6241EF2EF6",
        "p:0/321D6826-1013-4DF0-B53C-6F6241EF2EF6",
      ],
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
    const message = {
      id: 12347,
      guid: "p:0/GUID-media-failure",
      sender: "+15555550123",
      text: "/reset",
      is_from_me: false,
      is_group: false,
    };
    const decision = await resolveDecision({ message });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }

    const { ctxPayload } = await buildIMessageInboundContext({
      cfg: {} as OpenClawConfig,
      accountService: undefined,
      decision: {
        ...decision,
        agentBodyText: "/reset\n\n[imessage attachment unavailable]",
      },
      message,
      historyLimit: 0,
      groupHistories: new Map(),
    });

    expect(ctxPayload.RawBody).toBe("/reset");
    expect(ctxPayload.CommandBody).toBe("/reset");
    expect(ctxPayload.BodyForAgent).toBe("/reset\n\n[imessage attachment unavailable]");
    expect(ctxPayload.Body).toContain("/reset\n\n[imessage attachment unavailable]");
  });

  it("prepends direct-message history when supplied", async () => {
    const message = {
      id: 12346,
      guid: "p:0/GUID-current-history",
      sender: "+15555550123",
      text: "current",
      is_from_me: false,
      is_group: false,
    };
    const decision = await resolveDecision({ message });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }

    const { ctxPayload, inboundHistory } = await buildIMessageInboundContext({
      cfg: {} as OpenClawConfig,
      accountService: undefined,
      decision,
      message,
      historyLimit: 0,
      groupHistories: new Map(),
      dmHistory: {
        body: "[iMessage from +15555550123]\nprevious\n[/iMessage]",
        inboundHistory: [{ sender: "+15555550123", body: "previous" }],
      },
    });

    expect(ctxPayload.Body).toContain("previous");
    expect(ctxPayload.Body).toContain("current");
    expect(ctxPayload.InboundHistory).toEqual([{ sender: "+15555550123", body: "previous" }]);
    expect(inboundHistory).toEqual([{ sender: "+15555550123", body: "previous" }]);
  });

  it("uses the monitor's prepared account service without re-reading channel config", async () => {
    const message = {
      id: 12348,
      sender: "+15555550123",
      text: "current",
      is_from_me: false,
      is_group: false,
    };
    const decision = await resolveDecision({ message });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }

    let channelConfigReads = 0;
    const projectionCfg = Object.defineProperty({}, "channels", {
      enumerable: true,
      get: () => {
        channelConfigReads += 1;
        return { imessage: { service: "imessage" } };
      },
    }) as OpenClawConfig;
    const { ctxPayload, imessageTo } = await buildIMessageInboundContext({
      cfg: projectionCfg,
      accountService: "sms",
      decision,
      message,
      historyLimit: 0,
      groupHistories: new Map(),
    });

    expect(ctxPayload.MessageSid).toBeUndefined();
    expect(imessageTo).toBe("sms:+15555550123");
    expect(channelConfigReads).toBe(0);
  });
});
