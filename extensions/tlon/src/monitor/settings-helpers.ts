import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { TlonSettingsStore } from "../settings.js";
import { normalizeShip } from "../targets.js";
import type { TlonResolvedAccount } from "../types.js";

export function buildTlonSettingsMigrations(
  account: TlonResolvedAccount,
  currentSettings: TlonSettingsStore,
): Array<{ key: keyof TlonSettingsStore; fileValue: unknown; settingsValue: unknown }> {
  const configuredClubRules =
    Object.keys(account.clubRules).length > 0 ? JSON.stringify(account.clubRules) : undefined;
  const keys = [
    "dmAllowlist",
    "clubPolicy",
    "clubRules",
    "groupInviteAllowlist",
    "groupChannels",
    "defaultAuthorizedShips",
    "autoDiscoverChannels",
    "autoAcceptDmInvites",
    "autoAcceptGroupInvites",
  ] as const;
  return [
    ...keys.map((key) => ({
      key,
      fileValue: key === "clubRules" ? configuredClubRules : account[key],
      settingsValue: currentSettings[key],
    })),
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
    effectiveClubPolicy: settings.clubPolicy ?? account.clubPolicy ?? "approve-once",
    effectiveClubRules: settings.clubRules ?? account.clubRules,
    effectiveShowModelSig: settings.showModelSig ?? account.showModelSignature ?? false,
    effectiveAutoAcceptDmInvites:
      settings.autoAcceptDmInvites ?? account.autoAcceptDmInvites ?? false,
    effectiveAutoAcceptGroupInvites:
      settings.autoAcceptGroupInvites ?? account.autoAcceptGroupInvites ?? false,
    effectiveGroupInviteAllowlist: settings.groupInviteAllowlist ?? account.groupInviteAllowlist,
    explicitChannels: mergeUniqueStrings(account.groupChannels, settings.groupChannels),
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

export function createTlonSettingsInstaller(
  state: ReturnType<typeof applyTlonSettingsOverrides>,
  account: TlonResolvedAccount,
  log?: (message: string) => void,
) {
  return (currentSettings: TlonSettingsStore, preserveApprovalState = false) => {
    const pendingApprovals = state.pendingApprovals;
    const effectiveDmAllowlist = state.effectiveDmAllowlist;
    const effectiveClubRules = state.effectiveClubRules;
    Object.assign(state, applyTlonSettingsOverrides({ account, currentSettings, log }));
    if (preserveApprovalState) {
      state.pendingApprovals = pendingApprovals;
      state.effectiveDmAllowlist = effectiveDmAllowlist;
      state.effectiveClubRules = effectiveClubRules;
    }
  };
}
