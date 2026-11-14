export const GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY = "git.coauthor.organization";

export type GitCoauthorIdentity = { name: string; email: string };

/** Keep public-GitHub credit presentation aligned with the verified account’s commit address. */
export function publicGitHubCoauthorEmail(accountId: number, login: string): string {
  return `${accountId}+${login}@users.noreply.github.com`;
}

/** A complete credit pair forms exactly one Git trailer, never another header or identity. */
export function normalizeGitCoauthorIdentity(value: unknown): GitCoauthorIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  if (!("name" in value) || !("email" in value)) {
    return undefined;
  }
  if (typeof value.name !== "string" || typeof value.email !== "string") {
    return undefined;
  }
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u.test(value.name) || /[\p{Cc}\p{Cf}]/u.test(value.email)) {
    return undefined;
  }
  const name = value.name.trim();
  const email = value.email.trim();
  if (
    !name ||
    name.length > 256 ||
    email.length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/u.test(email)
  ) {
    return undefined;
  }
  return { name, email: email.toLowerCase() };
}

export type GitCoauthorOrganizationIdentity = GitCoauthorIdentity & { policy: string };

/** Bind imported metadata to the proxy mapping that admitted it, not merely its presence. */
export function gitCoauthorOrganizationPolicy(
  userHeader: string | undefined,
  mapping: { nameHeader: string; emailHeader: string; emailVerifiedHeader?: string },
): string {
  return JSON.stringify(
    [userHeader, mapping.nameHeader, mapping.emailHeader, mapping.emailVerifiedHeader].map(
      (header) => header?.toLowerCase() ?? null,
    ),
  );
}

export function normalizeGitCoauthorOrganizationIdentity(
  value: unknown,
): GitCoauthorOrganizationIdentity | undefined {
  const identity = normalizeGitCoauthorIdentity(value);
  if (
    !identity ||
    typeof value !== "object" ||
    value === null ||
    !("policy" in value) ||
    typeof value.policy !== "string" ||
    !value.policy ||
    value.policy.length > 2_048
  ) {
    return undefined;
  }
  return { ...identity, policy: value.policy };
}
