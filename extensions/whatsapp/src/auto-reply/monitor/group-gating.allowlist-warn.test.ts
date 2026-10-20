// Whatsapp tests cover group gating.allowlist warn plugin behavior.
import { describe, expect, it, vi } from "vitest";

vi.mock("./group-activation.js", () => ({
  resolveGroupActivationFor: vi.fn(async () => "mention"),
}));

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildGroupHistoryKey } from "openclaw/plugin-sdk/routing";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { createGroupGatingTestHandler } from "./group-gating.test-harness.js";

function makeUnregisteredGroupMsg(
  conversationId: string,
  accountId = "default",
): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    event: {
      id: `msg-${conversationId}`,
      timestamp: 1700000000,
    },
    payload: {
      body: "@openclaw hello",
    },
    platform: {
      chatJid: conversationId,
      recipientJid: "+15550000001",
      sender: { e164: "+15550000002", name: "Alice" },
    },
    admission: {
      accountId,
      conversation: {
        kind: "group",
        id: conversationId,
      },
      sender: {
        id: "+15550000002",
      },
      senderAccess: {
        reasonCode: "group_policy_allowed",
      },
    },
  });
}

type WarnLogger = (...args: unknown[]) => void;
type GroupTestParams = { cfg: OpenClawConfig };

function makeParams(
  msg: AdmittedWebInboundMessage,
  warn: ReturnType<typeof vi.fn<WarnLogger>>,
  cfg: GroupTestParams["cfg"] = {
    channels: {
      whatsapp: {
        groupPolicy: "allowlist",
        groups: {
          "registered@g.us": {},
        },
        accounts: {
          work: {
            groupPolicy: "allowlist",
            groups: {
              "registered@g.us": {},
            },
          },
        },
      },
    },
    messages: {
      groupChat: {
        mentionPatterns: ["\\bopenclaw\\b"],
      },
    },
  } as never,
) {
  const admission = msg.admission;
  if (!admission) {
    throw new Error("Expected admitted WhatsApp test message");
  }
  const fixture = createGroupGatingTestHandler({ cfg, warn });
  return {
    ...fixture,
    cfg,
    msg,
    groupHistoryKey: buildGroupHistoryKey({
      channel: "whatsapp",
      accountId: admission.accountId,
      peerKind: "group",
      peerId: admission.conversation.id,
    }),
    logVerbose: fixture.verboseMock,
  };
}

async function handleGroup(params: ReturnType<typeof makeParams>) {
  const before = params.processMock.mock.calls.length;
  await params.handler(params.msg);
  return { shouldProcess: params.processMock.mock.calls.length > before };
}

describe("WhatsApp group admission drop warning", () => {
  it.each([
    {
      name: "names the root groups path for non-default accounts inheriting root groups",
      conversationId: "inherited-unregistered@g.us",
      accountId: "work",
      groupsPath: "channels.whatsapp.groups",
      cfg: {
        channels: {
          whatsapp: {
            groupPolicy: "allowlist",
            groups: { "registered@g.us": {} },
            accounts: { work: { groupPolicy: "allowlist" } },
          },
        },
        messages: { groupChat: { mentionPatterns: ["\\bopenclaw\\b"] } },
      } as GroupTestParams["cfg"],
      verboseMessage: undefined,
    },
  ])("$name", async ({ conversationId, accountId, groupsPath, cfg, verboseMessage }) => {
    const warn = vi.fn<WarnLogger>();
    const msg = makeUnregisteredGroupMsg(conversationId, accountId);
    const params = makeParams(msg, warn, cfg);

    await expect(handleGroup(params)).resolves.toEqual({ shouldProcess: false });

    expect(warn).toHaveBeenCalledTimes(1);
    if (verboseMessage) {
      expect(params.logVerbose).toHaveBeenCalledWith(verboseMessage);
    }
    const [context, message] = warn.mock.calls[0] ?? [];
    expect(context).toMatchObject({ conversationId, accountId, groupsPath });
    expect(message).toContain(conversationId);
    expect(message).toContain(groupsPath);
  });

  it("does not warn when the group is registered", async () => {
    const warn = vi.fn<WarnLogger>();
    const msg = makeUnregisteredGroupMsg("registered@g.us");

    await handleGroup(makeParams(msg, warn));

    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once per account and group for identity-derived mention drops", async () => {
    const warn = vi.fn<WarnLogger>();
    const cfg = {
      agents: { entries: { main: { identity: { name: "Claw" } } } },
      channels: {
        whatsapp: {
          groups: { "*": {} },
          accounts: { work: { groups: { "*": {} } } },
        },
      },
    } satisfies GroupTestParams["cfg"];
    const makeUnmentioned = (conversationId: string, accountId = "default") => {
      const msg = makeUnregisteredGroupMsg(conversationId, accountId);
      msg.payload.body = "What up";
      return makeParams(msg, warn, cfg);
    };
    const first = makeUnmentioned("mention-a@g.us");

    await expect(handleGroup(first)).resolves.toEqual({ shouldProcess: false });
    await handleGroup(first);
    await handleGroup(makeUnmentioned("mention-b@g.us"));
    await handleGroup(makeUnmentioned("mention-a@g.us", "work"));

    expect(warn).toHaveBeenCalledTimes(3);
    expect(first.groupHistories.get(first.groupHistoryKey)?.map((entry) => entry.body)).toEqual([
      "What up",
      "What up",
    ]);
    expect(first.logVerbose).toHaveBeenCalledWith(expect.stringContaining("no mention detected"));
    expect(
      JSON.stringify([first.logVerbose.mock.calls, warn.mock.calls]).toLowerCase(),
    ).not.toContain("what up");
    expect(warn.mock.calls[0]?.[1]).toContain(
      'channels.whatsapp.groups["mention-a@g.us"].requireMention',
    );
    expect(warn.mock.calls[2]?.[1]).toContain(
      'channels.whatsapp.accounts.work.groups["mention-a@g.us"].requireMention',
    );
    expect(warn.mock.calls[0]?.[1]).toContain("false");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("What up");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("+15550000002");
  });
});
