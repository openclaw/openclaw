export const GIT_COAUTHOR_IDENTITY_PREFERENCE_KEY = "git.coauthor.identity";
export const GIT_COAUTHOR_ORGANIZATION_PREFERENCE_KEY = "git.coauthor.organization";

export type GitCoauthorIdentity = { name: string; email: string };

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
