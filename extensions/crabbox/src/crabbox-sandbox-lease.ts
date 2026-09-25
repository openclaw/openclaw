import { randomBytes } from "node:crypto";

export const CRABBOX_SANDBOX_LEASE_ID_PATTERN = /^cbx_[a-f0-9]{12}$/u;

/** The sandbox registry persists this generation before Crabbox provisioning starts. */
export function mintCrabboxSandboxLeaseId(): string {
  return `cbx_${randomBytes(6).toString("hex")}`;
}
