import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestWebInboundMessage } from "../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../inbound/types.js";
import { runGroupGatingTestMessage as runGroupGating } from "./monitor/group-gating.test-harness.js";
import { formatWhatsAppInboundListeningLog } from "./monitor/listener-log.js";
import { buildInboundLine } from "./monitor/message-line.js";

let sessionDir: string | undefined;
let sessionStorePath: string;

beforeEach(async () => {
  sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-group-gating-"));
  sessionStorePath = path.join(sessionDir, "sessions.json");
  await fs.writeFile(sessionStorePath, "{}");
});

afterEach(async () => {
  if (sessionDir) {
    await fs.rm(sessionDir, { recursive: true, force: true });
    sessionDir = undefined;
  }
});

function makeConfig(
  whatsapp: NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]> = {},
  overrides: Record<string, unknown> = {},
): OpenClawConfig {
  return {
    channels: { whatsapp },
    session: { store: sessionStorePath },
    ...overrides,
  } as unknown as OpenClawConfig;
}

type TestMessageOverrides = {
  admission?: NonNullable<Parameters<typeof createTestWebInboundMessage>[0]>["admission"];
  body?: string;
  id?: string;
  mentionedJids?: string[];
  replyToBody?: string;
  replyToId?: string;
  replyToSender?: string;
  replyToSenderE164?: string;
  replyToSenderJid?: string;
  selfE164?: string;
  selfJid?: string;
  senderE164?: string;
  senderJid?: string;
  senderName?: string;
  timestamp?: number;
  to?: string;
};

function createMessage(
  kind: "group" | "direct",
  overrides: TestMessageOverrides = {},
): AdmittedWebInboundMessage {
  const conversationId =
    overrides.admission?.conversation?.id ?? (kind === "group" ? "123@g.us" : "+1555");
  const senderE164 = overrides.senderE164 ?? (kind === "group" ? "+111" : conversationId);
  return createTestWebInboundMessage({
    event: { id: overrides.id ?? (kind === "group" ? "g1" : "d1"), timestamp: overrides.timestamp },
    payload: { body: overrides.body ?? `hello ${kind}` },
    platform: {
      chatJid: conversationId,
      recipientJid: overrides.to ?? "+2",
      senderE164,
      senderJid: overrides.senderJid,
      senderName: overrides.senderName ?? "Alice",
      selfE164: overrides.selfE164 ?? "+999",
      selfJid: overrides.selfJid,
    },
    admission: {
      ...overrides.admission,
      accountId: overrides.admission?.accountId ?? "default",
      conversation: {
        kind,
        id: conversationId,
        ...overrides.admission?.conversation,
      },
      sender: {
        id: overrides.senderJid ?? senderE164,
        ...overrides.admission?.sender,
      },
      ...(kind === "group"
        ? {
            senderAccess: {
              reasonCode: "group_policy_allowed",
              ...overrides.admission?.senderAccess,
            },
          }
        : {}),
    },
    quote: overrides.replyToBody
      ? {
          id: overrides.replyToId,
          body: overrides.replyToBody,
          sender: {
            displayName: overrides.replyToSender,
            jid: overrides.replyToSenderJid,
            e164: overrides.replyToSenderE164,
          },
        }
      : undefined,
    ...(kind === "group"
      ? {
          group: { mentions: { jids: overrides.mentionedJids } },
        }
      : {}),
  });
}

const createGroupMessage = (overrides: TestMessageOverrides = {}) =>
  createMessage("group", overrides);
const createDirectMessage = (overrides: TestMessageOverrides = {}) =>
  createMessage("direct", overrides);

function createReplyToBot(overrides: TestMessageOverrides) {
  return createGroupMessage({
    selfJid: "15551234567@s.whatsapp.net",
    selfE164: "+15551234567",
    replyToId: "m0",
    replyToSender: "+15551234567",
    replyToSenderJid: "15551234567@s.whatsapp.net",
    replyToSenderE164: "+15551234567",
    ...overrides,
  });
}

describe("WhatsApp listener diagnostics", () => {
  it("describes WhatsApp inbound listener scope without implying DM-only routing", () => {
    const expectScope = (
      groupPolicy: Parameters<typeof formatWhatsAppInboundListeningLog>[0]["groupPolicy"],
      hasGroupAllowFrom: boolean,
      scope: string,
      groups?: Record<string, unknown>,
    ) =>
      expect(formatWhatsAppInboundListeningLog({ groupPolicy, hasGroupAllowFrom, groups })).toBe(
        `Listening for WhatsApp inbound messages (DM + ${scope}).`,
      );
    expectScope("open", false, "all groups; no group allowlist configured");
    expectScope("disabled", true, "groups disabled by groupPolicy");
    expectScope("allowlist", false, "group inbound blocked by empty groupPolicy allowlist");
    expectScope("allowlist", true, "all groups; sender allowlist configured");
    expectScope("allowlist", true, "all groups; wildcard configured", { "123@g.us": {}, "*": {} });
    expectScope("allowlist", true, "2 configured groups", { "123@g.us": {}, "456@g.us": {} });
  });
});

describe("applyGroupGating", () => {
  it("does not treat self-number quoted replies as implicit mention in selfChatMode groups", async () => {
    const cfg = makeConfig({
      selfChatMode: true,
      groupPolicy: "open",
      groups: { "*": { requireMention: true } },
    });
    const { result } = await runGroupGating({
      cfg,
      msg: createReplyToBot({
        id: "m-self-reply",
        to: "+15550000",
        body: "following up on my own message",
        timestamp: Date.now(),
        senderE164: "+15551234567",
        senderJid: "15551234567@s.whatsapp.net",
        replyToBody: "my earlier message",
      }),
    });

    expect(result.shouldProcess).toBe(false);
  });

  it("still treats reply-to-bot as implicit mention in selfChatMode when sender is a different user", async () => {
    const cfg = makeConfig({
      selfChatMode: true,
      groupPolicy: "open",
      groups: { "*": { requireMention: true } },
    });
    const { result } = await runGroupGating({
      cfg,
      msg: createReplyToBot({
        id: "m-other-reply",
        to: "+15550000",
        body: "following up on bot reply",
        timestamp: Date.now(),
        senderE164: "+15559999999",
        senderJid: "15559999999@s.whatsapp.net",
        replyToBody: "bot earlier response",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("uses account-scoped groupPolicy and groupAllowFrom for named-account group gating", async () => {
    const cfg = makeConfig({
      groupPolicy: "allowlist",
      accounts: {
        work: { groupPolicy: "allowlist", groupAllowFrom: ["+111"] },
      },
    });

    const { result } = await runGroupGating({
      cfg,
      msg: createReplyToBot({
        id: "g-account-policy",
        admission: { accountId: "work" },
        body: "following up",
        senderJid: "111@s.whatsapp.net",
        replyToBody: "bot said hi",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("inherits group gating defaults from accounts.default for named accounts", async () => {
    const cfg = makeConfig({
      groupPolicy: "allowlist",
      accounts: {
        default: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
        work: {},
      },
    });

    const { result } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g-default-inheritance",
        admission: { accountId: "work" },
        body: "plain group message",
        senderJid: "111@s.whatsapp.net",
        selfJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("uses account-scoped allowFrom when bypassing mention gating for owner commands", async () => {
    const cfg = makeConfig({
      allowFrom: ["+999"],
      accounts: {
        work: { allowFrom: ["+111"] },
      },
    });

    const { result } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g-account-owner",
        admission: { accountId: "work" },
        body: "/new",
        senderName: "Owner",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("processes a pattern-matching message that also @-mentions another member (#109488)", async () => {
    const cfg = makeConfig(
      { groups: { "*": { requireMention: true } } },
      {
        messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
      },
    );

    // A native third-party mention must not short-circuit mentionPatterns (#109488).
    const { result } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g-other-mention-pattern",
        body: "@openclaw please check this",
        mentionedJids: ["15550000000@s.whatsapp.net"],
        selfE164: "+15551234567",
        selfJid: "15551234567@s.whatsapp.net",
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("does not bypass mention gating for non-owner /new in group chats", async () => {
    const cfg = makeConfig({ allowFrom: ["+999"], groups: { "*": { requireMention: true } } });

    const { result, groupHistories } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g-new-unauth",
        body: "/new",
        senderName: "NotOwner",
      }),
    });

    expect(result.shouldProcess).toBe(false);
    expect(groupHistories.get("whatsapp:default:group:123@g.us")?.length).toBe(1);
  });

  it("uses per-agent mention patterns for group gating (routing + mentionPatterns)", async () => {
    const cfg = makeConfig(
      { allowFrom: ["*"], groups: { "*": { requireMention: true } } },
      {
        messages: { groupChat: { mentionPatterns: ["@global"] } },
        agents: {
          entries: {
            work: { groupChat: { mentionPatterns: ["@workbot"] } },
          },
        },
        bindings: [
          {
            agentId: "work",
            match: {
              provider: "whatsapp",
              peer: { kind: "group", id: "123@g.us" },
            },
          },
        ],
      },
    );

    const route = resolveAgentRoute({
      cfg,
      channel: "whatsapp",
      peer: { kind: "group", id: "123@g.us" },
    });
    expect(route.agentId).toBe("work");

    const { result: globalMention } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g1",
        body: "@global ping",
      }),
    });
    expect(globalMention.shouldProcess).toBe(false);

    const { result: workMention } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        id: "g2",
        body: "@workbot ping",
        senderE164: "+222",
        senderName: "Bob",
      }),
    });
    expect(workMention.shouldProcess).toBe(true);
  });

  it("blocks group messages when whatsapp groups is set without a wildcard", async () => {
    const cfg = makeConfig({
      allowFrom: ["*"],
      groups: { "999@g.us": { requireMention: false } },
    });

    const { result, verboseLogs } = await runGroupGating({
      cfg,
      msg: createGroupMessage({
        body: "@workbot ping",
        mentionedJids: ["999@s.whatsapp.net"],
        selfJid: "999@s.whatsapp.net",
      }),
    });

    expect(result.shouldProcess).toBe(false);
    expect(verboseLogs).toContain(
      'Dropping message from unregistered WhatsApp group 123@g.us. Add the group JID to channels.whatsapp.groups, or add "*" there to admit all groups. Sender authorization still applies.',
    );
  });
});

describe("buildInboundLine", () => {
  it("prefixes group messages with sender", () => {
    const line = buildInboundLine({
      msg: createGroupMessage({
        body: "ping",
        timestamp: 1700000000000,
        senderJid: "111@s.whatsapp.net",
        senderE164: "+15550001111",
        senderName: "Bob",
      }),
    });

    expect(line).toContain("Bob (+15550001111):");
    expect(line).toContain("ping");
  });

  it("includes reply-to context blocks when replyToBody is present", () => {
    const line = buildInboundLine({
      msg: createDirectMessage({
        body: "hello",
        replyToId: "q1",
        replyToBody: "original",
        replyToSender: "+1999",
      }),
      envelope: { includeTimestamp: false },
    });

    expect(line).toContain("[Replying to +1999 id:q1]");
    expect(line).toContain("original");
    expect(line).toContain("[/Replying]");
  });
  it("uses unknown sender label when reply sender is absent", () => {
    const line = buildInboundLine({
      msg: createDirectMessage({ body: "ping", replyToBody: "original" }),
      envelope: { includeTimestamp: false },
    });
    expect(line).toContain("[Replying to unknown sender]\noriginal\n[/Replying]");
  });
});
