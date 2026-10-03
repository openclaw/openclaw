import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import { captureGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";

class SandboxStateOwnerRequiredError extends Error {
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

/** Retain hosted custody; standalone SDK preparation stays local when the root is offline. */
export async function captureSandboxStateOwner(): Promise<() => void> {
  const resolveTarget = () =>
    resolveIdentityPathViaExistingAncestorSync(resolveOpenClawStateSqlitePath());
  try {
    const env = { ...process.env };
    const databasePath = resolveTarget();
    const owner = captureGatewayStateOwner(databasePath);
    if (owner && owner.role !== "gateway" && owner.role !== "agent-embedded") {
      throw new SandboxStateOwnerRequiredError();
    }
    if (
      !owner &&
      (await readActiveGatewayLockIdentity({ env, includeEmbedded: true, requireInspection: true }))
    ) {
      throw new SandboxStateOwnerRequiredError();
    }
    const assertCurrent = () => {
      try {
        if (resolveTarget() !== databasePath) {
          throw new SandboxStateOwnerRequiredError();
        }
        owner?.assertCurrent();
      } catch (error) {
        if (error instanceof SandboxStateOwnerRequiredError) {
          throw error;
        }
        throw new SandboxStateOwnerRequiredError(error);
      }
    };
    assertCurrent();
    return assertCurrent;
  } catch (error) {
    if (error instanceof SandboxStateOwnerRequiredError) {
      throw error;
    }
    throw new SandboxStateOwnerRequiredError(error);
  }
}
