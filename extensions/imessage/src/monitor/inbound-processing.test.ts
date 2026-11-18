import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { loadFreshIMessageReplyCacheForTest } from "../test-support/runtime.js";
import {
  createInboundDecisionParams,
  type InboundDecisionParams,
} from "./inbound-decision.test-support.js";
import { resolveIMessageReactionContext } from "./reaction-context.js";
import { SelfChatCache } from "./self-chat-cache.js";

type InboundProcessingModule = typeof import("./inbound-processing.js");
let rememberIMessageReplyCache: (typeof import("../monitor-reply-cache.js"))["rememberIMessageReplyCache"];
let buildIMessageInboundContext: InboundProcessingModule["buildIMessageInboundContext"];
let resolveIMessageInboundDecision: InboundProcessingModule["resolveIMessageInboundDecision"];

beforeAll(async () => {
  ({ rememberIMessageReplyCache } = await loadFreshIMessageReplyCacheForTest());
  ({ buildIMessageInboundContext, resolveIMessageInboundDecision } =
    await import("./inbound-processing.js"));
});

function resolveDecision(overrides: Parameters<typeof createInboundDecisionParams>[0] = {}) {
  return resolveIMessageInboundDecision(createInboundDecisionParams(overrides));
}

function reactionMessage(overrides: Partial<InboundDecisionParams["message"]> = {}) {
  return {
    is_reaction: true,
    text: "",
    reaction_emoji: "👍",
    reacted_to_guid: "target-guid",
    ...overrides,
  };
}

async function buildContext(
  text: string,
  overrides: Partial<Parameters<typeof buildIMessageInboundContext>[0]> & {
    agentBodyText?: string;
  } = {},
) {
  const message = createInboundDecisionParams({ message: { text } }).message;
  const { agentBodyText, ...contextOverrides } = overrides;
  const decision = await resolveDecision({ message });
  if (decision.kind !== "dispatch") {
    throw new Error("expected dispatch decision");
  }
  return buildIMessageInboundContext({
    cfg: {},
    accountService: undefined,
    decision: { ...decision, agentBodyText: agentBodyText ?? decision.agentBodyText },
    message,
    historyLimit: 0,
    groupHistories: new Map(),
    ...contextOverrides,
  });
}

async function captureDropLog() {
  const runtimeEnv = await import("openclaw/plugin-sdk/runtime-env");
  const log = vi.spyOn(runtimeEnv, "logVerbose").mockImplementation(() => {});
  onTestFinished(() => log.mockRestore());
  return log;
}

describe("resolveIMessageInboundDecision echo detection", () => {
  it.each([
    ["message ID", "Reasoning:\n_step_", undefined],
    ["attachment-only media", "", [{ contentType: "image/png", kind: "image" }]],
  ] as const)(
    "drops echoes matching %s without logging message content",
    async (_name, text, mediaFacts) => {
      const logVerbose = await captureDropLog();
      const decision = await resolveDecision({
        message: { text },
        mediaFacts,
        echoCache: {
          has: (_scope, lookup) =>
            lookup.messageId === "42" && (!mediaFacts || lookup.media?.kind === "image"),
        },
      });

      expect(decision).toEqual({ kind: "drop", reason: "echo" });
      expect(logVerbose).toHaveBeenCalledWith(expect.stringContaining("id=42"));
      expect(logVerbose.mock.calls.flat().join("\n")).not.toContain("Reasoning:");
    },
  );

  it.each([true, false])("keeps group GUID scoping (explicit=%s)", async (is_group) => {
    const decision = await resolveDecision({
      cfg: { channels: { imessage: { groups: { "42": {} } } } },
      message: {
        id: 9001,
        chat_id: 42,
        chat_guid: "iMessage;+;chat0000",
        chat_identifier: "chat0000",
        text: "fresh inbound",
        is_group,
      },
      echoCache: {
        has: (scope, lookup) =>
          scope === "default:chat_guid:iMessage;+;OTHER" && lookup.messageId === "9001",
      },
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("logs reflected duplicate drops without message content", async () => {
    const selfChatCache = new SelfChatCache();
    const logVerbose = await captureDropLog();
    const bodyText = "line-1\nline-2\t\u001b[31mred";
    const resolveReflection = (message: Partial<InboundDecisionParams["message"]>) =>
      resolveDecision({
        selfChatCache,
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

  it.each([
    [undefined, true, undefined],
    ["own", false, "reaction target not sent by agent"],
    ["off", false, "reaction notifications disabled"],
  ] as const)(
    "resolves reaction notifications: %s (owned=%s)",
    async (reactionNotifications, owned, reason) => {
      const decision = await resolveDecision({
        reactionNotifications,
        message: reactionMessage(),
        echoCache: { has: (_scope, lookup) => owned && lookup.messageId === "target-guid" },
      });
      if (reason) {
        expect(decision).toEqual({ kind: "drop", reason });
      } else {
        expect(decision).toMatchObject({
          kind: "reaction",
          text: "iMessage reaction added: 👍 by +15555550123 on msg target-guid",
          route: { sessionKey: "agent:main:main" },
          contextKey: expect.stringContaining("imessage:reaction:added"),
        });
      }
    },
  );

  it("dispatches ordinary quoted prose instead of dropping it as a tapback", async () => {
    const decision = await resolveDecision({
      message: {
        associated_message_type: 1,
        text: "Loved “Dune” and the soundtrack was incredible",
      },
    });
    expect(decision.kind).toBe("dispatch");
  });

  it("uses the production reply-cache lookup for bot-authored reaction targets", async () => {
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "p:0/imsg-production",
      chatId: 3,
      timestamp: Date.now(),
      isFromMe: true,
    });

    const decision = await resolveDecision({
      message: reactionMessage({
        is_reaction: undefined,
        reaction_emoji: "❤️",
        reacted_to_guid: undefined,
        associated_message_guid: "p:0/imsg-production",
        associated_message_type: 2000,
        chat_id: 3,
      }),
      echoCache: { has: () => false },
    });

    expect(decision).toMatchObject({
      kind: "reaction",
      text: "iMessage reaction added: ❤️ by +15555550123 on msg imsg-production",
      reaction: {
        targetGuid: "imsg-production",
        targetGuids: ["imsg-production", "p:0/imsg-production"],
      },
    });
  });
});

describe("resolveIMessageReactionContext", () => {
  it.each([
    [{}, "Loved “Hello”", { action: "added", emoji: "❤️", targetText: "Hello" }],
    [
      { is_tapback: true, reaction_emoji: "👍", reacted_to_guid: "target" },
      "",
      { action: "added", emoji: "👍", targetGuid: "target", targetGuids: ["target"] },
    ],
    [
      { associated_message_type: 2001 },
      "",
      { action: "added", emoji: "reaction", targetGuid: undefined, targetGuids: [] },
    ],
  ] as const)("parses reaction %#", (message, body, expected) => {
    expect(resolveIMessageReactionContext(message, body)).toStrictEqual(expected);
  });
});

describe("buildIMessageInboundContext", () => {
  it("keeps generated media notices out of command input", async () => {
    const { ctxPayload } = await buildContext("/reset", {
      agentBodyText: "/reset\n\n[imessage attachment unavailable]",
    });
    expect(ctxPayload).toMatchObject({
      RawBody: "/reset",
      CommandBody: "/reset",
      BodyForAgent: "/reset\n\n[imessage attachment unavailable]",
    });
    expect(ctxPayload.Body).toContain("/reset\n\n[imessage attachment unavailable]");
  });

  it("prepends direct-message history when supplied", async () => {
    const inboundHistory = [{ sender: "+15555550123", body: "previous" }];
    const result = await buildContext("current", {
      dmHistory: {
        body: "[iMessage from +15555550123]\nprevious\n[/iMessage]",
        inboundHistory,
      },
    });
    expect(result.ctxPayload.Body).toMatch(/previous[\s\S]*current/);
    expect(result.ctxPayload.InboundHistory).toEqual(inboundHistory);
    expect(result.inboundHistory).toEqual(inboundHistory);
  });

  it("uses the monitor's prepared account service without re-reading channel config", async () => {
    const getChannels = vi.fn(() => ({ imessage: { service: "imessage" } }));
    const projectionCfg = Object.defineProperty({}, "channels", {
      enumerable: true,
      get: getChannels,
    }) as OpenClawConfig;
    const { ctxPayload, imessageTo } = await buildContext("current", {
      cfg: projectionCfg,
      accountService: "sms",
    });

    expect(ctxPayload.MessageSid).toBeUndefined();
    expect(imessageTo).toBe("sms:+15555550123");
    expect(getChannels).not.toHaveBeenCalled();
  });
});
