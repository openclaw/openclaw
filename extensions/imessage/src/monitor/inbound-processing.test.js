import { describe, expect, it, vi } from "vitest";
import { sanitizeTerminalText } from "../../../../src/terminal/safe-text.js";
import {
  describeIMessageEchoDropLog,
  resolveIMessageInboundDecision
} from "./inbound-processing.js";
import { createSelfChatCache } from "./self-chat-cache.js";
describe("resolveIMessageInboundDecision echo detection", () => {
  const cfg = {};
  function createInboundDecisionParams(overrides = {}) {
    const { message: messageOverrides, ...restOverrides } = overrides;
    const message = {
      id: 42,
      sender: "+15555550123",
      text: "ok",
      is_from_me: false,
      is_group: false,
      ...messageOverrides
    };
    const messageText = restOverrides.messageText ?? message.text ?? "";
    const bodyText = restOverrides.bodyText ?? messageText;
    const baseParams = {
      cfg,
      accountId: "default",
      opts: void 0,
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: /* @__PURE__ */ new Map(),
      echoCache: void 0,
      selfChatCache: void 0,
      logVerbose: void 0
    };
    return {
      ...baseParams,
      ...restOverrides,
      message,
      messageText,
      bodyText
    };
  }
  function resolveDecision(overrides = {}) {
    return resolveIMessageInboundDecision(createInboundDecisionParams(overrides));
  }
  it("drops inbound messages when outbound message id matches echo cache", () => {
    const echoHas = vi.fn((_scope, lookup) => {
      return lookup.messageId === "42";
    });
    const decision = resolveDecision({
      message: {
        id: 42,
        text: "Reasoning:\n_step_"
      },
      messageText: "Reasoning:\n_step_",
      bodyText: "Reasoning:\n_step_",
      echoCache: { has: echoHas }
    });
    expect(decision).toEqual({ kind: "drop", reason: "echo" });
    expect(echoHas).toHaveBeenCalledWith(
      "default:imessage:+15555550123",
      expect.objectContaining({
        text: "Reasoning:\n_step_",
        messageId: "42"
      })
    );
  });
  it("drops reflected self-chat duplicates after seeing the from-me copy", () => {
    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-02T20:58:10.649Z";
    expect(
      resolveDecision({
        message: {
          id: 9641,
          text: "Do you want to report this issue?",
          created_at: createdAt,
          is_from_me: true
        },
        messageText: "Do you want to report this issue?",
        bodyText: "Do you want to report this issue?",
        selfChatCache
      })
    ).toEqual({ kind: "drop", reason: "from me" });
    expect(
      resolveDecision({
        message: {
          id: 9642,
          text: "Do you want to report this issue?",
          created_at: createdAt
        },
        messageText: "Do you want to report this issue?",
        bodyText: "Do you want to report this issue?",
        selfChatCache
      })
    ).toEqual({ kind: "drop", reason: "self-chat echo" });
  });
  it("does not drop same-text messages when created_at differs", () => {
    const selfChatCache = createSelfChatCache();
    resolveDecision({
      message: {
        id: 9641,
        text: "ok",
        created_at: "2026-03-02T20:58:10.649Z",
        is_from_me: true
      },
      selfChatCache
    });
    const decision = resolveDecision({
      message: {
        id: 9642,
        text: "ok",
        created_at: "2026-03-02T20:58:11.649Z"
      },
      selfChatCache
    });
    expect(decision.kind).toBe("dispatch");
  });
  it("keeps self-chat cache scoped to configured group threads", () => {
    const selfChatCache = createSelfChatCache();
    const groupedCfg = {
      channels: {
        imessage: {
          groups: {
            "123": {},
            "456": {}
          }
        }
      }
    };
    const createdAt = "2026-03-02T20:58:10.649Z";
    expect(
      resolveDecision({
        cfg: groupedCfg,
        message: {
          id: 9701,
          chat_id: 123,
          text: "same text",
          created_at: createdAt,
          is_from_me: true
        },
        selfChatCache
      })
    ).toEqual({ kind: "drop", reason: "from me" });
    const decision = resolveDecision({
      cfg: groupedCfg,
      message: {
        id: 9702,
        chat_id: 456,
        text: "same text",
        created_at: createdAt
      },
      selfChatCache
    });
    expect(decision.kind).toBe("dispatch");
  });
  it("does not drop other participants in the same group thread", () => {
    const selfChatCache = createSelfChatCache();
    const createdAt = "2026-03-02T20:58:10.649Z";
    expect(
      resolveDecision({
        message: {
          id: 9751,
          chat_id: 123,
          text: "same text",
          created_at: createdAt,
          is_from_me: true,
          is_group: true
        },
        selfChatCache
      })
    ).toEqual({ kind: "drop", reason: "from me" });
    const decision = resolveDecision({
      message: {
        id: 9752,
        chat_id: 123,
        sender: "+15555550999",
        text: "same text",
        created_at: createdAt,
        is_group: true
      },
      selfChatCache
    });
    expect(decision.kind).toBe("dispatch");
  });
  it("sanitizes reflected duplicate previews before logging", () => {
    const selfChatCache = createSelfChatCache();
    const logVerbose = vi.fn();
    const createdAt = "2026-03-02T20:58:10.649Z";
    const bodyText = "line-1\nline-2	\x1B[31mred";
    resolveDecision({
      message: {
        id: 9801,
        text: bodyText,
        created_at: createdAt,
        is_from_me: true
      },
      messageText: bodyText,
      bodyText,
      selfChatCache,
      logVerbose
    });
    resolveDecision({
      message: {
        id: 9802,
        text: bodyText,
        created_at: createdAt
      },
      messageText: bodyText,
      bodyText,
      selfChatCache,
      logVerbose
    });
    expect(logVerbose).toHaveBeenCalledWith(
      `imessage: dropping self-chat reflected duplicate: "${sanitizeTerminalText(bodyText)}"`
    );
  });
});
describe("describeIMessageEchoDropLog", () => {
  it("includes message id when available", () => {
    expect(
      describeIMessageEchoDropLog({
        messageText: "Reasoning:\n_step_",
        messageId: "abc-123"
      })
    ).toContain("id=abc-123");
  });
});
describe("resolveIMessageInboundDecision command auth", () => {
  const cfg = {};
  const resolveDmCommandDecision = (params) => resolveIMessageInboundDecision({
    cfg,
    accountId: "default",
    message: {
      id: params.messageId,
      sender: "+15555550123",
      text: "/status",
      is_from_me: false,
      is_group: false
    },
    opts: void 0,
    messageText: "/status",
    bodyText: "/status",
    allowFrom: [],
    groupAllowFrom: [],
    groupPolicy: "open",
    dmPolicy: "open",
    storeAllowFrom: params.storeAllowFrom,
    historyLimit: 0,
    groupHistories: /* @__PURE__ */ new Map(),
    echoCache: void 0,
    logVerbose: void 0
  });
  it("does not auto-authorize DM commands in open mode without allowlists", () => {
    const decision = resolveDmCommandDecision({
      messageId: 100,
      storeAllowFrom: []
    });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.commandAuthorized).toBe(false);
  });
  it("authorizes DM commands for senders in pairing-store allowlist", () => {
    const decision = resolveDmCommandDecision({
      messageId: 101,
      storeAllowFrom: ["+15555550123"]
    });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.commandAuthorized).toBe(true);
  });
});
