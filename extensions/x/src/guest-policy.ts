import type { ResolvedXAccount } from "./accounts.js";
import { normalizeXUserId, readPublishedXAllowlist } from "./allowlist.js";
import type { XUser } from "./api.js";
import { getXRuntime } from "./runtime.js";

export type XSenderTier = "maintainer" | "guest";
const X_GUEST_READ_TOOLS = ["read", "ls"] as const;

export function resolveXGuestSettings(account: ResolvedXAccount) {
  return {
    enabled: account.config.guests?.enabled === true,
    maxMentionsPerAuthorPerDay: account.config.guests?.maxMentionsPerAuthorPerDay ?? 5,
    threadContextMaxPosts: account.config.guests?.threadContextMaxPosts ?? 10,
  };
}

export function resolveXSenderTier(
  account: ResolvedXAccount,
  senderId: string | undefined | null,
): XSenderTier {
  const id = senderId && normalizeXUserId(senderId);
  const allowed = [
    ...(account.config.allowFrom ?? []),
    ...readPublishedXAllowlist(getXRuntime(), account.accountId),
  ];
  return id && allowed.some((entry) => normalizeXUserId(entry) === id) ? "maintainer" : "guest";
}

export function resolveXGuestToolPolicy(account: ResolvedXAccount) {
  const configured = account.config.guests?.tools;
  const allow = X_GUEST_READ_TOOLS.filter(
    (name) => !configured?.allow || configured.allow.includes(name),
  );
  // An empty allow array means unrestricted to core; an empty guest selection means no tools.
  return allow.length
    ? { allow, deny: ["skills_read", ...(configured?.deny ?? [])] }
    : { deny: ["*"] };
}

export function formatXSenderLine(tier: XSenderTier, authorId: string, user?: XUser): string {
  const inline = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();
  const username = user?.username ? `@${inline(user.username)}` : "";
  const displayName = user?.name ? `(${inline(user.name)})` : "";
  const label = [username, displayName].filter(Boolean).join(" ");
  const sender = `${label ? `${label}, ` : ""}X user id ${authorId}`;
  return tier === "maintainer"
    ? `This is from a verified user: ${sender}, on the maintainer allowlist.`
    : `This is from a guest: ${sender}. Guest tier: answer from the OpenClaw repo only; you cannot open work sessions, write, run commands, or read other sessions for guests.`;
}
