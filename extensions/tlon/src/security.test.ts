import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
/**
 * Security Tests for Tlon Plugin
 *
 * These tests ensure that security-critical behavior cannot regress:
 * - DM allowlist enforcement
 * - Channel authorization rules
 * - Ship normalization consistency
 * - Bot mention detection boundaries
 */
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveChannelAuthorization } from "./monitor/authorization.js";
import { createTlonCitationResolver } from "./monitor/cites.js";
import { prepareTlonGroupAdmission } from "./monitor/mentions.js";
import {
  resolveTlonCommandAuthorizationWithIngress,
  isDmAllowedWithIngress,
  isGroupInviteAllowed,
  isBotMentioned,
  extractMessageText,
  resolveAuthorizedMessageText,
} from "./monitor/utils.js";
import { setTlonRuntime } from "./runtime.js";

beforeEach(() => {
  setTlonRuntime(createPluginRuntimeMock());
});

const allowlistShipMatchingCases = [
  { label: "DM allowlist", isAllowed: isDmAllowedWithIngress },
  { label: "group invite allowlist", isAllowed: isGroupInviteAllowed },
] satisfies Array<{
  label: string;
  isAllowed: (ship: string, allowlist: string[] | undefined) => boolean | Promise<boolean>;
}>;

async function expectAllowed(
  isAllowed: (ship: string, allowlist: string[] | undefined) => boolean | Promise<boolean>,
  ship: string,
  allowlist: string[] | undefined,
  expected: boolean,
) {
  await expect(Promise.resolve(isAllowed(ship, allowlist))).resolves.toBe(expected);
}

async function expectDmAllowed(ship: string, allowlist: string[] | undefined, expected: boolean) {
  await expect(isDmAllowedWithIngress(ship, allowlist)).resolves.toBe(expected);
}

describe("Security: allowlist ship matching", () => {
  it.each(allowlistShipMatchingCases)(
    "$label normalizes ship names with and without ~ prefix",
    async ({ isAllowed }) => {
      const allowlist = ["~zod"];
      await expectAllowed(isAllowed, "zod", allowlist, true);
      await expectAllowed(isAllowed, "~zod", allowlist, true);

      const allowlistWithoutTilde = ["zod"];
      await expectAllowed(isAllowed, "~zod", allowlistWithoutTilde, true);
      await expectAllowed(isAllowed, "zod", allowlistWithoutTilde, true);
    },
  );

  it.each(allowlistShipMatchingCases)(
    "$label rejects partial ship matches",
    async ({ isAllowed }) => {
      const allowlist = ["~zod"];
      await expectAllowed(isAllowed, "~zod-extra", allowlist, false);
      await expectAllowed(isAllowed, "~extra-zod", allowlist, false);
    },
  );
});

describe("Security: DM Allowlist", () => {
  describe("DM ingress allowlist", () => {
    it("rejects DMs when allowlist is empty", async () => {
      await expectDmAllowed("~zod", [], false);
      await expectDmAllowed("~sampel-palnet", [], false);
    });

    it("rejects DMs when allowlist is undefined", async () => {
      await expectDmAllowed("~zod", undefined, false);
    });

    it("handles whitespace in ship names (normalized)", async () => {
      // Ships with leading/trailing whitespace are normalized by normalizeShip
      const allowlist = [" ~zod ", "~bus"];
      await expectDmAllowed("~zod", allowlist, true);
      await expectDmAllowed(" ~zod ", allowlist, true);
    });

    it("uses the ingress command gate for owner-only command authorization", async () => {
      const authorized = await resolveTlonCommandAuthorizationWithIngress({
        senderShip: "~zod",
        ownerShip: "zod",
        useAccessGroups: true,
      });
      expect(authorized.commandAccess.requested).toBe(true);
      expect(authorized.commandAccess.authorized).toBe(true);
      expect(authorized.commandAccess.shouldBlockControlCommand).toBe(false);
      expect(authorized.commandAccess.reasonCode).toBe("command_authorized");

      const unauthorized = await resolveTlonCommandAuthorizationWithIngress({
        senderShip: "~nec",
        ownerShip: "~zod",
        useAccessGroups: true,
      });
      expect(unauthorized.commandAccess.requested).toBe(true);
      expect(unauthorized.commandAccess.authorized).toBe(false);
      expect(unauthorized.commandAccess.shouldBlockControlCommand).toBe(false);
    });
  });
});

describe("Security: Group Invite Allowlist", () => {
  describe("isGroupInviteAllowed", () => {
    it("rejects invites when allowlist is empty (fail-safe)", () => {
      // CRITICAL: Empty allowlist must DENY, not accept-all
      expect(isGroupInviteAllowed("~zod", [])).toBe(false);
      expect(isGroupInviteAllowed("~sampel-palnet", [])).toBe(false);
      expect(isGroupInviteAllowed("~malicious-actor", [])).toBe(false);
    });

    it("rejects invites when allowlist is undefined (fail-safe)", () => {
      // CRITICAL: Undefined allowlist must DENY, not accept-all
      expect(isGroupInviteAllowed("~zod", undefined)).toBe(false);
      expect(isGroupInviteAllowed("~sampel-palnet", undefined)).toBe(false);
    });

    it("handles whitespace in allowlist entries", () => {
      const allowlist = [" ~nocsyx-lassul ", "~malmur-halmex"];
      expect(isGroupInviteAllowed("~nocsyx-lassul", allowlist)).toBe(true);
    });
  });
});

describe("Security: Bot Mention Detection", () => {
  describe("isBotMentioned", () => {
    const botShip = "~sampel-palnet";
    const nickname = "nimbus";

    it("detects direct ship mention", () => {
      expect(isBotMentioned("hey ~sampel-palnet", botShip)).toBe(true);
      expect(isBotMentioned("~sampel-palnet can you help?", botShip)).toBe(true);
      expect(isBotMentioned("hello ~sampel-palnet how are you", botShip)).toBe(true);
    });

    it("detects @all mention", () => {
      expect(isBotMentioned("@all please respond", botShip)).toBe(true);
      expect(isBotMentioned("hey @all", botShip)).toBe(true);
      expect(isBotMentioned("@ALL uppercase", botShip)).toBe(true);
    });

    it("detects nickname mention", () => {
      expect(isBotMentioned("hey nimbus", botShip, nickname)).toBe(true);
      expect(isBotMentioned("nimbus help me", botShip, nickname)).toBe(true);
      expect(isBotMentioned("hello NIMBUS", botShip, nickname)).toBe(true);
    });

    it("does NOT trigger on partial ship matches", () => {
      expect(isBotMentioned("~sampel-palnet-extra", botShip)).toBe(false);
      expect(isBotMentioned("my~sampel-palnetfriend", botShip)).toBe(false);
    });

    it("does NOT trigger on substring nickname matches", () => {
      // "nimbus" should not match "nimbusy" or "animbust"
      expect(isBotMentioned("nimbusy", botShip, nickname)).toBe(false);
      expect(isBotMentioned("prenimbus", botShip, nickname)).toBe(false);
    });

    it("handles empty/null inputs safely", () => {
      expect(isBotMentioned("", botShip)).toBe(false);
      expect(isBotMentioned("test", "")).toBe(false);
      expect(isBotMentioned(null as unknown as string, botShip)).toBe(false);
    });

    it("requires word boundary for nickname", () => {
      expect(isBotMentioned("nimbus, hello", botShip, nickname)).toBe(true);
      expect(isBotMentioned("hello nimbus!", botShip, nickname)).toBe(true);
      expect(isBotMentioned("nimbus?", botShip, nickname)).toBe(true);
    });
  });
});

describe("Security: Group Mention Policy", () => {
  function groupAdmissionParams(
    overrides: Partial<Parameters<typeof prepareTlonGroupAdmission>[0]> = {},
  ): Parameters<typeof prepareTlonGroupAdmission>[0] {
    return {
      cfg: {},
      account: { accountId: "default" },
      api: { scry: async () => ({}) },
      channelNest: "chat/~host/general",
      botShipName: "~zod",
      botNickname: null,
      rawText: "follow up",
      messageSeal: { "parent-id": "1234" },
      isThreadReply: true,
      hasParticipatedInThread: (parentId) => parentId === "1234",
      getSettings: () => ({}),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      ...overrides,
    };
  }

  it("allows participated-thread follow-ups by default", async () => {
    const { mentionDecision } = await prepareTlonGroupAdmission(groupAdmissionParams());
    expect(mentionDecision).toMatchObject({
      shouldSkip: false,
      matchedImplicitMentionKinds: ["bot_thread_participant"],
    });
  });

  it("allows account policy to disable participated-thread follow-ups", async () => {
    const { mentionDecision } = await prepareTlonGroupAdmission(
      groupAdmissionParams({
        account: { accountId: "work" },
        cfg: {
          channels: {
            tlon: {
              implicitMentions: { threadParticipation: true },
              accounts: {
                work: { implicitMentions: { threadParticipation: false } },
              },
            },
          },
        },
      }),
    );
    expect(mentionDecision).toMatchObject({ shouldSkip: true, matchedImplicitMentionKinds: [] });
  });

  it("keeps explicit mentions enabled when thread participation is disabled", async () => {
    const { mentionDecision } = await prepareTlonGroupAdmission(
      groupAdmissionParams({
        rawText: "~zod follow up",
        cfg: {
          channels: { tlon: { implicitMentions: { threadParticipation: false } } },
        },
      }),
    );
    expect(mentionDecision).toMatchObject({ shouldSkip: false, effectiveWasMentioned: true });
  });
});

describe("Security: Message Text Extraction", () => {
  describe("extractMessageText", () => {
    it("extracts @all mentions from sect null", () => {
      const content = [{ inline: [{ sect: null }] }];
      expect(extractMessageText(content)).toContain("@all");
    });

    it("extracts ship mentions", () => {
      const content = [{ inline: [{ ship: "~zod" }] }];
      expect(extractMessageText(content)).toContain("~zod");
    });

    it("handles malformed input safely", () => {
      expect(extractMessageText(null)).toBe("");
      expect(extractMessageText(undefined)).toBe("");
      expect(extractMessageText([])).toBe("");
      expect(extractMessageText([{}])).toBe("");
      expect(extractMessageText("not an array")).toBe("");
    });
  });
});

describe("Security: Channel Authorization Logic", () => {
  const channelNest = "chat/~zod/test";

  it("defaults an unconfigured channel to restricted with no authorized ships", () => {
    expect(resolveChannelAuthorization({}, channelNest)).toEqual({
      mode: "restricted",
      allowedShips: [],
    });
  });

  it("keeps an explicit empty channel allowlist instead of inheriting defaults", () => {
    expect(
      resolveChannelAuthorization(
        {
          channels: {
            tlon: {
              defaultAuthorizedShips: ["~zod"],
              authorization: { channelRules: { [channelNest]: { allowedShips: [] } } },
            },
          },
        },
        channelNest,
      ),
    ).toEqual({ mode: "restricted", allowedShips: [] });
  });

  it("preserves explicit open channel policy", () => {
    expect(
      resolveChannelAuthorization(
        {
          channels: {
            tlon: {
              authorization: { channelRules: { [channelNest]: { mode: "open" } } },
            },
          },
        },
        channelNest,
      ),
    ).toEqual({ mode: "open", allowedShips: [] });
  });

  it("prefers settings channel rules over conflicting file configuration", () => {
    expect(
      resolveChannelAuthorization(
        {
          channels: {
            tlon: {
              authorization: {
                channelRules: { [channelNest]: { mode: "restricted", allowedShips: ["~zod"] } },
              },
            },
          },
        },
        channelNest,
        { channelRules: { [channelNest]: { mode: "open", allowedShips: ["~bus"] } } },
      ),
    ).toEqual({ mode: "open", allowedShips: ["~bus"] });
  });
});

describe("Security: Authorization Edge Cases", () => {
  it("empty strings are not valid ships", async () => {
    await expectDmAllowed("", ["~zod"], false);
    await expectDmAllowed("~zod", [""], false);
  });

  it("handles special characters that could break regex", async () => {
    // These should not cause regex injection
    const maliciousShip = "~zod.*";
    await expectDmAllowed("~zodabc", [maliciousShip], false);

    const allowlist = ["~zod"];
    await expectDmAllowed("~zod.*", allowlist, false);
  });

  it("protects against prototype pollution-style keys", async () => {
    const suspiciousShip = "__proto__";
    await expectDmAllowed(suspiciousShip, ["~zod"], false);
    await expectDmAllowed("~zod", [suspiciousShip], false);
  });
});

describe("Security: Cite Resolution Authorization Ordering", () => {
  const content = [
    {
      block: {
        cite: {
          chan: {
            nest: "chat/~private-ship/ops",
            where: "/msg/~victim-ship/170141184507799509469114119040828178432",
          },
        },
      },
    },
    { inline: ["~bot-ship please summarize this"] },
  ];
  const rawText = extractMessageText(content);

  function createResolver() {
    const scry = vi.fn(async () => ({ essay: { content: [{ inline: ["PRIVATE-CONTENT"] }] } }));
    return {
      scry,
      ...createTlonCitationResolver({ api: { scry }, runtime: createNonExitingRuntimeEnv() }),
    };
  }

  it("does not fetch cited content before sender authorization", async () => {
    const { scry, resolveAllCites } = createResolver();
    await expect(
      resolveAuthorizedMessageText({
        rawText,
        content,
        authorizedForCites: false,
        resolveAllCites,
      }),
    ).resolves.toBe(rawText);
    expect(scry).not.toHaveBeenCalled();
  });

  it("prepends the resolved citation after sender authorization", async () => {
    const { scry, resolveAllCites } = createResolver();
    await expect(
      resolveAuthorizedMessageText({ rawText, content, authorizedForCites: true, resolveAllCites }),
    ).resolves.toBe(`> ~victim-ship wrote: PRIVATE-CONTENT\n\n${rawText}`);
    expect(scry).toHaveBeenCalledTimes(1);
  });
});
