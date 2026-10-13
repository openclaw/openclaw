import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { ResolvedXAccount } from "./accounts.js";
import { normalizeXUserId, readPublishedXAllowlist, type XGitHubEntry } from "./allowlist.js";
import type { XUser } from "./api.js";
import { X_GUEST_TOOLS } from "./guest-tools.js";
import { getXRuntime } from "./runtime.js";

export type XSenderTier = "maintainer" | "guest";

export function supportsXGuestHelpers(
  runtime: Pick<PluginRuntime, "capabilities"> = getXRuntime(),
) {
  return runtime.capabilities?.includes("sender-restricted-hidden-helpers-v1") === true;
}

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
    ...readPublishedXAllowlist(getXRuntime(), account.accountId, account.config.verifiedFromGitHub),
  ];
  return id && allowed.some((entry) => normalizeXUserId(entry) === id) ? "maintainer" : "guest";
}

export function resolveXGuestToolPolicy(account: ResolvedXAccount) {
  const configured = account.config.guests?.tools;
  const helpersAvailable = supportsXGuestHelpers();
  const allow = X_GUEST_TOOLS.filter(
    (name) =>
      (helpersAvailable || name === "read" || name === "ls") &&
      (!configured?.allow || configured.allow.includes(name)),
  );
  // An empty allow array means unrestricted to core; an empty guest selection means no tools.
  return allow.length
    ? { allow, deny: ["skills_read", ...(configured?.deny ?? [])] }
    : { deny: ["*"] };
}

export function formatXSenderLine(
  tier: XSenderTier,
  authorId: string,
  user?: XUser,
  github?: { repo: string; entry: XGitHubEntry },
): string {
  const inline = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").trim();
  const username = user?.username ? `@${inline(user.username)}` : "";
  const displayName = user?.name ? `(${inline(user.name)})` : "";
  const label = [username, displayName].filter(Boolean).join(" ");
  const sender = `${label ? `${label}, ` : ""}X user id ${authorId}`;
  if (tier === "maintainer") {
    if (github) {
      return `This is from a verified user: ${sender}, GitHub @${inline(github.entry.githubLogin)} with write access to ${inline(github.repo)}.`;
    }
    return `This is from a verified user: ${sender}, on the maintainer allowlist.`;
  }
  const helperGuidance = supportsXGuestHelpers()
    ? "hidden helpers must use the same agent and repository. You cannot open visible work sessions"
    : "this host supports read-only guest answers. You cannot start helpers or work sessions";
  return `This is from a guest: ${sender}. Guest tier: answer from the OpenClaw repo only; ${helperGuidance}, write, run commands, or read unrelated sessions for guests.`;
}
