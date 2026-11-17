import {
  resolveIdentityPathViaExistingAncestor,
  resolveIdentityPathViaExistingAncestorSync,
} from "../../infra/boundary-path.js";
import { normalizeWindowsPathForComparison } from "../../infra/path-guards.js";

export type SandboxStateOwnerPath = { path: string; canonicalPath: string };

export class SandboxStateOwnerRequiredError extends Error {
  readonly code = "GATEWAY_STATE_OWNER_REQUIRED";

  constructor(cause?: unknown) {
    super(
      "Sandbox workspace preparation cannot run alongside a foreign live owner of the selected " +
        "state root, or when that ownership cannot be verified. Run this SDK call inside the " +
        "owning Gateway plugin/runtime, or stop the Gateway through its service owner and wait " +
        "for any embedded run to finish, then retry offline. Inspect openclaw gateway status; " +
        "this call does not acquire ownership or route remotely.",
      { cause },
    );
    this.name = "SandboxStateOwnerRequiredError";
  }
}

function assertCanonicalPath(evidence: SandboxStateOwnerPath, current: string): void {
  const normalize = process.platform === "win32" ? normalizeWindowsPathForComparison : String;
  if (normalize(current) !== normalize(evidence.canonicalPath)) {
    throw new SandboxStateOwnerRequiredError(
      new Error("Sandbox state path changed while preparing an operation"),
    );
  }
}

/** Worker-side physical selection; the host grants live custody after this can block. */
export function assertSandboxStateOwnerPathCurrent(evidence: SandboxStateOwnerPath): void {
  assertCanonicalPath(evidence, resolveIdentityPathViaExistingAncestorSync(evidence.path));
}

export async function prepareSandboxStateOwnerPath(evidence: SandboxStateOwnerPath): Promise<void> {
  assertCanonicalPath(evidence, await resolveIdentityPathViaExistingAncestor(evidence.path));
}
