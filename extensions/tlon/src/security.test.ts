import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveChannelAuthorization } from "./monitor/authorization.js";
import { prepareTlonGroupAdmission } from "./monitor/mentions.js";
import {
  resolveTlonCommandAuthorizationWithIngress,
  isDmAllowedWithIngress,
  isGroupInviteAllowed,
  isBotMentioned,
  extractMessageText,
} from "./monitor/utils.js";
import { setTlonRuntime } from "./runtime.js";

beforeEach(() => setTlonRuntime(createPluginRuntimeMock()));

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

it.each(allowlistShipMatchingCases)(
  "$label rejects partial ship matches",
  async ({ isAllowed }) => {
    const allowlist = ["~zod"];
    await expectAllowed(isAllowed, "~zod-extra", allowlist, false);
    await expectAllowed(isAllowed, "~extra-zod", allowlist, false);
  },
);

describe.each(allowlistShipMatchingCases)("Security: $label", ({ isAllowed }) => {
  it.each([{ allowlist: [] }, { allowlist: undefined }])(
    "rejects absent/empty allowlist $allowlist",
    async ({ allowlist }) => {
      await expectAllowed(isAllowed, "~zod", allowlist, false);
      await expectAllowed(isAllowed, "~sampel-palnet", allowlist, false);
    },
  );
  it("normalizes whitespace in allowlist entries and senders", async () => {
    await expectAllowed(isAllowed, "~zod", [" ~zod ", "~bus"], true);
    await expectAllowed(isAllowed, " ~zod ", [" ~zod ", "~bus"], true);
  });
});

it.each([
  ["~zod", "zod", true],
  ["~nec", "~zod", false],
] as const)("authorizes %s with owner %s: %s", async (senderShip, ownerShip, authorized) => {
  const { commandAccess } = await resolveTlonCommandAuthorizationWithIngress({
    senderShip,
    ownerShip,
  });
  expect(commandAccess).toMatchObject({
    requested: true,
    authorized,
    shouldBlockControlCommand: false,
  });
  if (authorized) {
    expect(commandAccess.reasonCode).toBe("command_authorized");
  }
});

describe("Security: Bot Mention Detection", () => {
  const botShip = "~sampel-palnet";
  it.each([
    ["@all", ["@all please respond", "hey @all", "@ALL uppercase"], undefined, true],
    ["partial ship", ["~sampel-palnet-extra", "my~sampel-palnetfriend"], undefined, false],
    ["substring nickname", ["nimbusy", "prenimbus"], "nimbus", false],
    ["nickname boundary", ["nimbus, hello", "hello nimbus!", "nimbus?"], "nimbus", true],
  ] as const)("detects %s matches", (_name, texts, nick, expected) => {
    for (const text of texts) {
      expect(isBotMentioned(text, botShip, nick)).toBe(expected);
    }
  });

  it("handles empty/null inputs safely", () => {
    expect(isBotMentioned("", botShip)).toBe(false);
    expect(isBotMentioned("test", "")).toBe(false);
    expect(isBotMentioned(null as unknown as string, botShip)).toBe(false);
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
      senderShip: "~nec",
      isOwner: () => false,
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
  it.each([
    [{ sect: null }, "@all"],
    [{ ship: "~zod" }, "~zod"],
  ] as const)("extracts mention %j", (mention, expected) => {
    expect(extractMessageText([{ inline: [mention] }])).toContain(expected);
  });

  it("handles malformed input safely", () => {
    expect(extractMessageText(null)).toBe("");
    expect(extractMessageText(undefined)).toBe("");
    expect(extractMessageText([])).toBe("");
    expect(extractMessageText([{}])).toBe("");
    expect(extractMessageText("not an array")).toBe("");
  });
});

describe("Security: Channel Authorization Logic", () => {
  const channelNest = "chat/~zod/test";
  const channelConfig = (
    rule: { mode?: "restricted"; allowedShips: string[] },
    defaultAuthorizedShips?: string[],
  ) => ({
    channels: {
      tlon: {
        defaultAuthorizedShips,
        authorization: { channelRules: { [channelNest]: rule } },
      },
    },
  });

  it("defaults an unconfigured channel to restricted with no authorized ships", () => {
    expect(resolveChannelAuthorization({}, channelNest)).toEqual({
      mode: "restricted",
      allowedShips: [],
    });
  });

  it("keeps an explicit empty channel allowlist instead of inheriting defaults", () => {
    expect(
      resolveChannelAuthorization(channelConfig({ allowedShips: [] }, ["~zod"]), channelNest),
    ).toEqual({
      mode: "restricted",
      allowedShips: [],
    });
  });

  it("prefers settings channel rules over conflicting file configuration", () => {
    expect(
      resolveChannelAuthorization(
        channelConfig({ mode: "restricted", allowedShips: ["~zod"] }),
        channelNest,
        { channelRules: { [channelNest]: { mode: "open", allowedShips: ["~bus"] } } },
      ),
    ).toEqual({ mode: "open", allowedShips: ["~bus"] });
  });
});

it("empty strings are not valid ships", async () => {
  await expectAllowed(isDmAllowedWithIngress, "", ["~zod"], false);
  await expectAllowed(isDmAllowedWithIngress, "~zod", [""], false);
});
