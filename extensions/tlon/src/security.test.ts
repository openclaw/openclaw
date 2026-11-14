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

describe.each([
  { label: "DM allowlist", isAllowed: isDmAllowedWithIngress },
  { label: "group invite allowlist", isAllowed: isGroupInviteAllowed },
])("Security: $label", ({ isAllowed }) => {
  it.each([
    ["partial matches", ["~zod-extra", "~extra-zod"], ["~zod"], false],
    ["empty allowlist", ["~zod", "~sampel-palnet"], [], false],
    ["absent allowlist", ["~zod", "~sampel-palnet"], undefined, false],
    ["normalized whitespace", ["~zod", " ~zod "], [" ~zod ", "~bus"], true],
  ] satisfies Array<[string, string[], string[] | undefined, boolean]>)(
    "checks %s",
    async (_name, senders, allowlist, allowed) => {
      for (const sender of senders) {
        expect(await isAllowed(sender, allowlist)).toBe(allowed);
      }
    },
  );
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

it.each([
  ["@ALL uppercase", "~sampel-palnet", undefined, true],
  ["~sampel-palnet-extra", "~sampel-palnet", undefined, false],
  ["my~sampel-palnetfriend", "~sampel-palnet", undefined, false],
  ["prenimbus", "~sampel-palnet", "nimbus", false],
  ["nimbusy", "~sampel-palnet", "nimbus", false],
  ["nimbus, hello", "~sampel-palnet", "nimbus", true],
  ["", "~sampel-palnet", undefined, false],
  ["test", "", undefined, false],
  [null as unknown as string, "~sampel-palnet", undefined, false],
] as const)("detects mentions in %j", (text, ship, nick, expected) => {
  expect(isBotMentioned(text, ship, nick)).toBe(expected);
});

it.each([false, true])("admits thread follow-up with explicit mention: %s", async (explicit) => {
  const { mentionDecision } = await prepareTlonGroupAdmission({
    cfg: explicit
      ? { channels: { tlon: { implicitMentions: { threadParticipation: false } } } }
      : {},
    account: { accountId: "default" },
    api: { scry: async () => ({}) },
    channelNest: "chat/~host/general",
    senderShip: "~nec",
    isOwner: () => false,
    botShipName: "~zod",
    botNickname: null,
    rawText: explicit ? "~zod follow up" : "follow up",
    messageSeal: { "parent-id": "1234" },
    isThreadReply: true,
    hasParticipatedInThread: (parentId) => parentId === "1234",
    getSettings: () => ({}),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  });
  expect(mentionDecision).toMatchObject({
    shouldSkip: false,
    ...(explicit
      ? { effectiveWasMentioned: true }
      : { matchedImplicitMentionKinds: ["bot_thread_participant"] }),
  });
});

it.each([
  [{ sect: null }, "@all"],
  [{ ship: "~zod" }, "~zod"],
] as const)("extracts mention %j", (mention, expected) => {
  expect(extractMessageText([{ inline: [mention] }])).toBe(expected);
});

it("handles malformed message content safely", () => {
  for (const content of [null, undefined, [], [{}], "not an array"]) {
    expect(extractMessageText(content)).toBe("");
  }
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

  it.each([
    ["unconfigured channel", {}],
    ["explicit empty allowlist overriding defaults", channelConfig({ allowedShips: [] }, ["~zod"])],
  ] as const)("restricts %s", (_name, cfg) => {
    expect(resolveChannelAuthorization(cfg, channelNest)).toEqual({
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
  expect(await isDmAllowedWithIngress("", ["~zod"])).toBe(false);
  expect(await isDmAllowedWithIngress("~zod", [""])).toBe(false);
});
