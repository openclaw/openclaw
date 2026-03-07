import type { ChannelId } from "openclaw/plugin-sdk";
import {
  readStoreAllowFromForDmPolicy,
  resolveAllowlistMatchSimple,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
} from "openclaw/plugin-sdk";

export function normalizePumbleAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed.replace(/^(pumble|user):/i, "").toLowerCase();
}

export function normalizePumbleAllowList(entries: Array<string | number>): string[] {
  const normalized = entries
    .map((entry) => normalizePumbleAllowEntry(String(entry)))
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

export function resolvePumbleEffectiveAllowFromLists(params: {
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
}): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  return resolveEffectiveAllowFromLists({
    allowFrom: normalizePumbleAllowList(params.allowFrom ?? []),
    groupAllowFrom: normalizePumbleAllowList(params.groupAllowFrom ?? []),
    storeAllowFrom: normalizePumbleAllowList(params.storeAllowFrom ?? []),
    dmPolicy: params.dmPolicy,
  });
}

/**
 * Resolve access decision for a Pumble inbound event (message, reaction, edit).
 * Normalizes allowlists, reads the pairing store, and delegates to the shared
 * `resolveDmGroupAccessWithLists` utility.
 */
export async function resolvePumbleAccessDecision(params: {
  accountConfig: {
    allowFrom?: Array<string | number> | null;
    groupAllowFrom?: Array<string | number> | null;
    dmPolicy?: string | null;
  };
  accountId: string;
  readStoreForDmPolicy: (provider: ChannelId, accountId: string) => Promise<string[]>;
  kind: string;
  groupPolicy: string;
  senderId: string;
  senderName?: string;
}) {
  const dmPolicy = (params.accountConfig.dmPolicy as string) ?? "pairing";
  const normalizedAllowFrom = normalizePumbleAllowList(params.accountConfig.allowFrom ?? []);
  const normalizedGroupAllowFrom = normalizePumbleAllowList(
    params.accountConfig.groupAllowFrom ?? [],
  );
  const storeAllowFrom = normalizePumbleAllowList(
    await readStoreAllowFromForDmPolicy({
      provider: "pumble",
      accountId: params.accountId,
      dmPolicy,
      readStore: params.readStoreForDmPolicy,
    }),
  );
  return {
    dmPolicy,
    normalizedAllowFrom,
    ...resolveDmGroupAccessWithLists({
      isGroup: params.kind !== "direct",
      dmPolicy,
      groupPolicy: params.groupPolicy,
      allowFrom: normalizedAllowFrom,
      groupAllowFrom: normalizedGroupAllowFrom,
      storeAllowFrom,
      isSenderAllowed: (af) =>
        isPumbleSenderAllowed({
          senderId: params.senderId,
          senderName: params.senderName,
          allowFrom: af,
        }),
    }),
  };
}

export function isPumbleSenderAllowed(params: {
  senderId: string;
  senderName?: string;
  allowFrom: string[];
}): boolean {
  const allowFrom = normalizePumbleAllowList(params.allowFrom);
  if (allowFrom.length === 0) {
    return false;
  }
  const match = resolveAllowlistMatchSimple({
    allowFrom,
    senderId: normalizePumbleAllowEntry(params.senderId),
    senderName: params.senderName ? normalizePumbleAllowEntry(params.senderName) : undefined,
  });
  return match.allowed;
}
