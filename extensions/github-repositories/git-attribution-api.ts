import type {
  GitCoauthorFormatInputV1,
  FormattedGitCoauthorV1,
} from "openclaw/plugin-sdk/execution-environment";
import { resolveConfiguredGitHubHost } from "./host-api.js";
import { resolveConfiguredGitHubToolIdentity } from "./tool-identity-api.js";

/** Formatting is pure: participant selection, consent, ordering and lifetime remain host-owned. */
export function formatGitHubCoauthor(
  input: GitCoauthorFormatInputV1,
): FormattedGitCoauthorV1 | null | undefined {
  const issuer = input.issuer ?? resolveConfiguredGitHubHost(input.config);
  const { identity } = input;
  if (identity.issuer !== issuer) {
    return undefined;
  }
  if (identity.subject === input.excludeSubject) {
    return null;
  }
  const email =
    issuer === "github.com"
      ? `${identity.subject}+${identity.name}@users.noreply.github.com`
      : identity.verifiedEmail;
  if (!email) {
    return null;
  }
  const primaryIdentity =
    resolveConfiguredGitHubToolIdentity({ ...input, scope: "agent" }) ??
    resolveConfiguredGitHubToolIdentity({ ...input, scope: "system" });
  const primaryEmail = primaryIdentity?.gitAuthor?.email?.trim().toLowerCase();
  // An explicit publisher replaces the configured primary; the other account may deserve credit.
  if (input.excludeSubject === undefined && email.toLowerCase() === primaryEmail) {
    return null;
  }
  return {
    name: identity.name,
    trailer: `Co-authored-by: ${identity.name} <${email}>`,
  };
}
