import { describe, expect, it } from "vitest";
import type { TlonResolvedAccount } from "../types.js";
import {
  applyTlonSettingsOverrides,
  buildTlonSettingsMigrations,
  shouldMigrateTlonSetting,
} from "./settings-helpers.js";

const baseAccount: TlonResolvedAccount = {
  accountId: "default",
  name: "Tlon",
  enabled: true,
  configured: true,
  ship: "~sampel-palnet",
  url: "https://example.com",
  code: "lidlut-tabwed-pillex-ridrup",
  dangerouslyAllowPrivateNetwork: false,
  groupChannels: ["chat/~host/general"],
  dmAllowlist: ["~zod"],
  groupInviteAllowlist: ["~bus"],
  autoDiscoverChannels: true,
  crossChannelCitations: null,
  showModelSignature: false,
  autoAcceptDmInvites: true,
  autoAcceptGroupInvites: true,
  defaultAuthorizedShips: ["~nec"],
  ownerShip: "~marzod",
};

const applySettings = (
  currentSettings: Parameters<typeof applyTlonSettingsOverrides>[0]["currentSettings"],
) => applyTlonSettingsOverrides({ account: baseAccount, currentSettings });

describe("Tlon settings", () => {
  it.each([false, true])("migrates only missing allowlists (%s)", (missing) => {
    const value = missing ? undefined : [];
    const settings = {
      dmAllowlist: value,
      groupInviteAllowlist: value,
      defaultAuthorizedShips: value,
    };
    const migrations = buildTlonSettingsMigrations(baseAccount, settings);
    const decisions = migrations.map(({ key, fileValue, settingsValue }) => [
      key,
      shouldMigrateTlonSetting(fileValue, settingsValue),
    ]);
    expect(Object.fromEntries(decisions)).toMatchObject({
      dmAllowlist: missing,
      groupInviteAllowlist: missing,
      defaultAuthorizedShips: missing,
    });
  });
  it("treats explicit empty settings allowlists as authoritative deny-all", () => {
    const result = applySettings({ dmAllowlist: [], groupInviteAllowlist: [] });
    expect(result.effectiveDmAllowlist).toStrictEqual([]);
    expect(result.effectiveGroupInviteAllowlist).toStrictEqual([]);
  });

  it("falls back to file config when settings fields are removed", () => {
    expect(applySettings({})).toMatchObject({
      effectiveDmAllowlist: baseAccount.dmAllowlist,
      effectiveGroupInviteAllowlist: baseAccount.groupInviteAllowlist,
      effectiveAutoDiscoverChannels: baseAccount.autoDiscoverChannels,
      effectiveOwnerShip: baseAccount.ownerShip,
    });
  });

  it("keeps other explicit settings overrides authoritative", () => {
    const result = applySettings({
      autoDiscoverChannels: false,
      autoAcceptDmInvites: false,
      autoAcceptGroupInvites: false,
      showModelSig: true,
      ownerShip: "~nec",
      pendingApprovals: [],
    });
    expect(result).toMatchObject({
      effectiveAutoDiscoverChannels: false,
      effectiveAutoAcceptDmInvites: false,
      effectiveAutoAcceptGroupInvites: false,
      effectiveShowModelSig: true,
      effectiveOwnerShip: "~nec",
    });
    expect(result.pendingApprovals).toStrictEqual([]);
  });
});
