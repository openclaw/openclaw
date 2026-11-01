import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestWebInboundMessage } from "../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../inbound/types.js";
import { runGroupGatingTestMessage as runGroupGating } from "./monitor/group-gating.test-harness.js";

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

type TestMessageOverrides = Partial<AdmittedWebInboundMessage["platform"]> & {
  admission?: NonNullable<Parameters<typeof createTestWebInboundMessage>[0]>["admission"];
  body?: string;
  id?: string;
  mentionedJids?: string[];
  replyToBody?: string;
};

function createGroupMessage({
  admission,
  body = "hello group",
  id = "g1",
  mentionedJids,
  replyToBody,
  ...platform
}: TestMessageOverrides = {}): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    event: { id },
    payload: { body },
    platform: {
      chatJid: "123@g.us",
      recipientJid: "+2",
      senderE164: "+111",
      senderName: "Alice",
      selfE164: "+999",
      ...platform,
    },
    admission: {
      conversation: { kind: "group", id: "123@g.us" },
      sender: { id: platform.senderJid ?? platform.senderE164 ?? "+111" },
      senderAccess: { reasonCode: "group_policy_allowed" },
      ...admission,
    },
    quote: replyToBody
      ? {
          id: "m0",
          body: replyToBody,
          sender: {
            displayName: "+15551234567",
            jid: "15551234567@s.whatsapp.net",
            e164: "+15551234567",
          },
        }
      : undefined,
    group: { mentions: { jids: mentionedJids } },
  });
}

function createBotGroupMessage(overrides: TestMessageOverrides) {
  return createGroupMessage({
    selfJid: "15551234567@s.whatsapp.net",
    selfE164: "+15551234567",
    ...overrides,
  });
}

describe("applyGroupGating", () => {
  it.each<[string, string[] | undefined, boolean]>([
    ["Order 15551234567 is ready", undefined, false],
    ["Invoice 9915551234567001 is overdue", undefined, false],
    ["Meeting at 15:55, room 123, ext 4567", undefined, false],
    ["Call +1 (555) 123-4567", undefined, false],
    ["1555\n1234567", undefined, false],
    ["order@15551234567.example", undefined, false],
    ["cafe\u0301@15551234567.example", undefined, false],
    ["@15551234567\u0301abc", undefined, false],
    ["@9915551234567001", undefined, false],
    ["@15551234567abc", undefined, false],
    ["@15551234567", undefined, true],
    ["Please (@+15551234567), help", undefined, true],
    ["Please help", ["15551234567@s.whatsapp.net"], true],
    ["@15550000000", ["15550000000@s.whatsapp.net"], false],
  ])("dispatches %j with native mentions %j: %s", async (body, mentionedJids, shouldProcess) => {
    const msg = createBotGroupMessage({ body, mentionedJids });
    const { result, groupHistories } = await runGroupGating({
      cfg: makeConfig(
        { groupPolicy: "open", groups: { "*": { requireMention: true } } },
        { messages: { groupChat: { mentionPatterns: [] } } },
      ),
      msg,
    });
    expect(result.shouldProcess).toBe(shouldProcess);
    expect(msg.groupMention).toEqual({ wasMentioned: shouldProcess, requireMention: true });
    expect(
      groupHistories.get("whatsapp:default:group:123@g.us")?.map((entry) => entry.body),
    ).toEqual(shouldProcess ? undefined : [body]);
  });

  it.each([
    ["15551234567", false],
    ["15559999999", true],
  ] as const)("gates selfChatMode quoted replies from %s: %s", async (sender, shouldProcess) => {
    const { result } = await runGroupGating({
      cfg: makeConfig({
        selfChatMode: true,
        groupPolicy: "open",
        groups: { "*": { requireMention: true } },
      }),
      msg: createBotGroupMessage({
        recipientJid: "+15550000",
        body: "following up",
        senderE164: `+${sender}`,
        senderJid: `${sender}@s.whatsapp.net`,
        replyToBody: "earlier message",
      }),
    });
    expect(result.shouldProcess).toBe(shouldProcess);
  });

  it.each<{
    name: string;
    whatsapp: Parameters<typeof makeConfig>[0];
    message: TestMessageOverrides;
  }>([
    {
      name: "account-scoped groupPolicy and groupAllowFrom",
      whatsapp: {
        groupPolicy: "allowlist",
        accounts: { work: { groupPolicy: "allowlist", groupAllowFrom: ["+111"] } },
      },
      message: { replyToBody: "bot said hi" },
    },
    {
      name: "inherited accounts.default group gating",
      whatsapp: {
        groupPolicy: "allowlist",
        accounts: {
          default: { groupPolicy: "open", groups: { "*": { requireMention: false } } },
          work: {},
        },
      },
      message: { body: "plain group message" },
    },
    {
      name: "account-scoped allowFrom for owner commands",
      whatsapp: { allowFrom: ["+999"], accounts: { work: { allowFrom: ["+111"] } } },
      message: { body: "/new", senderName: "Owner" },
    },
  ])("uses $name", async ({ whatsapp, message }) => {
    const { result } = await runGroupGating({
      cfg: makeConfig(whatsapp),
      msg: createBotGroupMessage({
        admission: { accountId: "work" },
        senderJid: "111@s.whatsapp.net",
        ...message,
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

    const { result } = await runGroupGating({
      cfg,
      msg: createBotGroupMessage({
        body: "@openclaw please check this",
        mentionedJids: ["15550000000@s.whatsapp.net"],
      }),
    });

    expect(result.shouldProcess).toBe(true);
  });

  it("does not bypass mention gating for non-owner /new in group chats", async () => {
    const { result, groupHistories } = await runGroupGating({
      cfg: makeConfig({ allowFrom: ["+999"], groups: { "*": { requireMention: true } } }),
      msg: createGroupMessage({ body: "/new", senderName: "NotOwner" }),
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
    const { result, verboseLogs } = await runGroupGating({
      cfg: makeConfig({ allowFrom: ["*"], groups: { "999@g.us": { requireMention: false } } }),
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
