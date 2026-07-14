import { normalizeCdpWsUrl } from "./cdp.js";
import type { ProfileRuntimeState } from "./server-context.types.js";

export function normalizeWsUrl(raw: string | undefined, cdpBaseUrl: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return normalizeCdpWsUrl(raw, cdpBaseUrl);
  } catch {
    return raw;
  }
}

const TAB_LABEL_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export function normalizeTabLabel(label: string): string {
  const trimmed = label.trim();
  if (!TAB_LABEL_PATTERN.test(trimmed)) {
    throw new Error("tab label must be 1-64 chars and use only letters, numbers, _, ., :, or -");
  }
  return trimmed;
}

export function getTabAliasState(
  profileState: ProfileRuntimeState,
): NonNullable<ProfileRuntimeState["tabAliases"]> {
  profileState.tabAliases ??= { nextTabNumber: 1, byTargetId: {} };
  return profileState.tabAliases;
}
