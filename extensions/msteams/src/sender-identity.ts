import type { GraphUser } from "./graph.js";

export type SenderIdentityPayload = {
  aadId: string;
  displayName: string | null;
  email: string | null;
  department: string | null;
  jobTitle: string | null;
};

export function buildSenderIdentityPayload(profile: GraphUser): SenderIdentityPayload | null {
  if (!profile.id) {
    return null;
  }
  return {
    aadId: profile.id,
    displayName: profile.displayName ?? null,
    email: profile.mail ?? profile.userPrincipalName ?? null,
    department: profile.department ?? null,
    jobTitle: profile.jobTitle ?? null,
  };
}

/**
 * Build an untrusted structured context entry for the sender's AAD profile.
 * This follows the same pattern as Discord channel metadata and WhatsApp
 * contacts: identity data flows through UntrustedStructuredContext so the
 * model receives it as metadata, not as trusted prompt authority.
 */
export function buildSenderIdentityContext(identity: SenderIdentityPayload): {
  label: string;
  source: string;
  type: string;
  payload: SenderIdentityPayload;
} {
  return {
    label: "Microsoft Teams sender identity",
    source: "msteams",
    type: "sender_identity",
    payload: identity,
  };
}
