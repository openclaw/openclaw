import type { GraphUser } from "./graph.js";

export type SenderIdentityBlock = {
  aadId: string;
  displayName: string | null;
  email: string | null;
  department: string | null;
  jobTitle: string | null;
};

export function buildSenderIdentityBlock(profile: GraphUser): SenderIdentityBlock | null {
  if (!profile.id) return null;
  return {
    aadId: profile.id,
    displayName: profile.displayName ?? null,
    email: profile.mail ?? profile.userPrincipalName ?? null,
    department: profile.department ?? null,
    jobTitle: profile.jobTitle ?? null,
  };
}

export function formatSenderIdentityContext(identity: SenderIdentityBlock): string {
  const json = JSON.stringify(identity, null, 2);
  return `## Sender Identity (trusted \u2014 Microsoft AAD)\n\`\`\`json\n${json}\n\`\`\``;
}
