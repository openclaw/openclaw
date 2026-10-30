import { resolveGatewayPublicOrigin } from "openclaw/plugin-sdk/config-contracts";
import type { VisitorTarget } from "./cloudflare.js";
import type { ActiveVisitorInvitation } from "./grant-record.js";
import type { VisitorInviteDetails } from "./tool-results.js";

/**
 * Where a visitor signs in: the operator-declared public Gateway origin plus the Control UI base
 * path, as for other external Control UI links. Undefined when the Control UI is disabled or no
 * usable gateway.publicOrigin is configured; callers must not substitute a guessed address.
 */
export function resolveVisitorSignInUrl({
  gateway,
}: {
  gateway?: { publicOrigin?: string; controlUi?: { enabled?: boolean; basePath?: string } };
}): string | undefined {
  const origin =
    gateway?.controlUi?.enabled === false
      ? undefined
      : resolveGatewayPublicOrigin({ gateway: { publicOrigin: gateway?.publicOrigin } });
  if (!origin) {
    return undefined;
  }
  const url = new URL(origin);
  // The pathname setter keeps the configured host, even for an unusual base path.
  url.pathname = gateway?.controlUi?.basePath?.trim() || "/";
  return url.pathname === "/" ? origin : url.href;
}

export function expiryText(expiresAt: number | null): string {
  return expiresAt === null ? "never (explicit forever grant)" : new Date(expiresAt).toISOString();
}

function utcMinute(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Tool result for a committed invite or renewal; the note appears only in the invitation text. */
export function visitorInviteResult({
  renewed,
  target,
  grant,
  gatewayAccess,
  signInUrl,
  noteSupplied,
}: {
  renewed: boolean;
  target: VisitorTarget;
  grant: ActiveVisitorInvitation;
  gatewayAccess: string;
  signInUrl?: string;
  noteSupplied: boolean;
}): { text: string; details: VisitorInviteDetails } {
  const { grantId, githubLogin, expiresAt } = grant;
  const who =
    typeof target === "number"
      ? `@${githubLogin} (GitHub account ${target})`
      : githubLogin
        ? `@${githubLogin} (${target})`
        : target;
  const noteStored = Boolean(grant.note?.trim());
  const inviter = grant.invitedBy?.label?.replace(/\s+/gu, " ").trim();
  const invitationIdentity =
    typeof target === "string"
      ? `the email ${target}`
      : githubLogin
        ? `your GitHub account @${githubLogin}`
        : `the GitHub account with ID ${target}`;
  const message = grant.note?.trim();
  const invitationText = [
    inviter ? `${inviter} invited you to OpenClaw.` : "You're invited to OpenClaw.",
    signInUrl
      ? `Sign in at ${signInUrl} with ${invitationIdentity}.`
      : `Ask ${inviter ?? "the person who invited you"} for the OpenClaw sign-in address, then sign in with ${invitationIdentity}.`,
    expiresAt === null
      ? "Your access does not expire."
      : `Your access expires on ${utcMinute(expiresAt)}.`,
    ...(message ? ["", `Note from ${inviter ?? "your inviter"}:`, message] : []),
  ].join("\n");
  const identity = typeof target === "number" ? "this GitHub account" : "this email";
  const signIn = signInUrl
    ? `Sign in at ${signInUrl} using Team's existing login with ${identity}. The link itself does not grant access.`
    : `No sign-in URL: set gateway.publicOrigin and keep the Control UI enabled to include one. The visitor signs in with ${identity} at the address you share.`;
  const noteStatus = noteStored
    ? noteSupplied
      ? " Inviter note stored."
      : " Existing inviter note kept."
    : "";
  return {
    text: `${renewed ? "Renewed" : "Invited"} ${who}. Invitation ID: ${grantId}. Visitor grant expires: ${expiryText(expiresAt)}. ${gatewayAccess}. ${signIn}${noteStatus}\n\nInvitation text to share with the visitor:\n${invitationText}`,
    details: {
      outcome: renewed ? "renewed" : "invited",
      grantId,
      ...(typeof target === "string" ? { email: target } : { githubAccountId: target }),
      ...(githubLogin ? { githubLogin } : {}),
      expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      gatewayAccess,
      ...(signInUrl ? { signInUrl } : {}),
      noteStored,
      invitationText,
    },
  };
}
