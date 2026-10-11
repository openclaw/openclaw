import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TlonSettingsStore } from "../settings.js";
import { normalizeShip } from "../targets.js";
import type { TlonResolvedAccount } from "../types.js";

export function buildTlonSettingsMigrations(
  account: TlonResolvedAccount,
  currentSettings: TlonSettingsStore,
): Array<{ key: keyof TlonSettingsStore; fileValue: unknown; settingsValue: unknown }> {
  const keys = [
    "dmAllowlist",
    "groupInviteAllowlist",
    "groupChannels",
    "defaultAuthorizedShips",
    "autoDiscoverChannels",
    "autoAcceptDmInvites",
    "autoAcceptGroupInvites",
  ] as const;
  return [
    ...keys.map((key) => ({ key, fileValue: account[key], settingsValue: currentSettings[key] })),
    {
      key: "showModelSig",
      fileValue: account.showModelSignature,
      settingsValue: currentSettings.showModelSig,
    },
  ];
}

export function shouldMigrateTlonSetting(fileValue: unknown, settingsValue: unknown): boolean {
  const hasFileValue = Array.isArray(fileValue) ? fileValue.length > 0 : fileValue != null;
  const hasSettingsValue = settingsValue != null;
  return hasFileValue && !hasSettingsValue;
}

export function applyTlonSettingsOverrides(params: {
  account: TlonResolvedAccount;
  currentSettings: TlonSettingsStore;
  log?: (message: string) => void;
}) {
  const { account, currentSettings: settings, log } = params;
  if (settings.defaultAuthorizedShips?.length) {
    log?.(
      `[tlon] Using defaultAuthorizedShips from settings store: ${settings.defaultAuthorizedShips.join(", ")}`,
    );
  }
  for (const key of [
    "autoDiscoverChannels",
    "dmAllowlist",
    "autoAcceptDmInvites",
    "autoAcceptGroupInvites",
    "groupInviteAllowlist",
  ] as const) {
    const value = settings[key];
    if (value !== undefined) {
      log?.(
        `[tlon] Using ${key} from settings store: ${Array.isArray(value) ? value.join(", ") : value}`,
      );
    }
  }
  const effectiveOwnerShip = settings.ownerShip
    ? normalizeShip(settings.ownerShip)
    : account.ownerShip
      ? normalizeShip(account.ownerShip)
      : null;
  if (settings.ownerShip) {
    log?.(`[tlon] Using ownerShip from settings store: ${effectiveOwnerShip}`);
  }
  if (settings.pendingApprovals?.length) {
    log?.(`[tlon] Loaded ${settings.pendingApprovals.length} pending approval(s) from settings`);
  }
  return {
    effectiveDmAllowlist: settings.dmAllowlist ?? account.dmAllowlist,
    effectiveShowModelSig: settings.showModelSig ?? account.showModelSignature ?? false,
    effectiveAutoAcceptDmInvites:
      settings.autoAcceptDmInvites ?? account.autoAcceptDmInvites ?? false,
    effectiveAutoAcceptGroupInvites:
      settings.autoAcceptGroupInvites ?? account.autoAcceptGroupInvites ?? false,
    effectiveGroupInviteAllowlist: settings.groupInviteAllowlist ?? account.groupInviteAllowlist,
    effectiveAutoDiscoverChannels:
      settings.autoDiscoverChannels ?? account.autoDiscoverChannels ?? false,
    effectiveOwnerShip,
    pendingApprovals: settings.pendingApprovals?.length ? settings.pendingApprovals : [],
    currentSettings: settings,
  };
}

export function mergeUniqueStrings(base: string[], next?: string[]): string[] {
  return uniqueStrings([...base, ...(next ?? [])]);
}
