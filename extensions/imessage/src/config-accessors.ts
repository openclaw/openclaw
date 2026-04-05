import type { MullusiConfig } from "mullusi/plugin-sdk/config-runtime";
import { resolveIMessageAccount } from "./accounts.js";

export function resolveIMessageConfigAllowFrom(params: {
  cfg: MullusiConfig;
  accountId?: string | null;
}): string[] {
  return (resolveIMessageAccount(params).config.allowFrom ?? []).map((entry) => String(entry));
}

export function resolveIMessageConfigDefaultTo(params: {
  cfg: MullusiConfig;
  accountId?: string | null;
}): string | undefined {
  const defaultTo = resolveIMessageAccount(params).config.defaultTo;
  if (defaultTo == null) {
    return undefined;
  }
  const normalized = String(defaultTo).trim();
  return normalized || undefined;
}
