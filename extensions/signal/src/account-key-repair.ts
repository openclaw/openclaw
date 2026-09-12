import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { ChannelDoctorConfigMutation } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

export function repairSignalAccountKeys({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const signal = cfg.channels?.signal;
  const accounts = signal?.accounts;
  if (!accounts) {
    return { config: cfg, changes: [] };
  }
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(accounts)) {
    if (key) {
      const id = normalizeAccountId(key);
      groups.set(id, [...(groups.get(id) ?? []), key]);
    }
  }
  const moves = new Map<string, string>();
  const warnings: string[] = [];
  for (const [id, keys] of groups) {
    if (keys.length > 1) {
      warnings.push(
        `Signal account keys ${keys.map((key) => JSON.stringify(key)).join(", ")} resolve to "${id}". Doctor preserved them; rename them so each account has a unique normalized key.`,
      );
      continue;
    }
    for (const key of keys) {
      if (normalizeLowercaseStringOrEmpty(key) !== id) {
        // An unreachable entry currently inherits the root number/default transport.
        // Making its overrides reachable must not redirect an already working route.
        if (
          normalizeOptionalString(signal?.account) ||
          (id === DEFAULT_ACCOUNT_ID && signal?.transport)
        ) {
          warnings.push(
            `Signal account "${key}" is listed as "${id}" but currently uses the channel defaults. Doctor preserved it to avoid changing a working account; check its settings before renaming the key to "${id}".`,
          );
          continue;
        }
        moves.set(key, id);
      }
    }
  }
  const repaired = Object.fromEntries(
    Object.entries(accounts).map(([key, entry]) => [moves.get(key) ?? key, entry]),
  );
  return {
    config: moves.size
      ? { ...cfg, channels: { ...cfg.channels, signal: { ...signal, accounts: repaired } } }
      : cfg,
    changes: [...moves].map(
      ([from, to]) => `Moved Signal account "${from}" to channels.signal.accounts.${to}.`,
    ),
    warnings,
  };
}
