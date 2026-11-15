import { readActiveGatewayLockIdentity } from "../../infra/gateway-lock.js";
import { captureStateDatabaseAccess } from "../../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  prepareSandboxStateOwnerPath,
  SandboxStateOwnerRequiredError,
} from "./state-owner-path.js";

/** Retain hosted custody; standalone SDK preparation stays local when the root is offline. */
export async function captureSandboxStateOwner() {
  try {
    const env = { ...process.env };
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const access = await captureStateDatabaseAccess(databasePath);
    const owner = access.processOwner;
    if (owner && owner.role !== "gateway" && owner.role !== "agent-embedded") {
      throw new SandboxStateOwnerRequiredError();
    }
    if (
      !owner &&
      (await readActiveGatewayLockIdentity({ env, includeEmbedded: true, requireInspection: true }))
    ) {
      throw new SandboxStateOwnerRequiredError();
    }
    const assertAccess = owner ? await access.prepareAccess() : undefined;
    const stateOwnerPath = { path: databasePath, canonicalPath: access.canonicalPath };
    const assertCurrent = () => {
      try {
        if (resolveOpenClawStateSqlitePath() !== databasePath) {
          throw new SandboxStateOwnerRequiredError();
        }
        owner?.assertCurrent();
        assertAccess?.();
      } catch (error) {
        if (error instanceof SandboxStateOwnerRequiredError) {
          throw error;
        }
        throw new SandboxStateOwnerRequiredError(error);
      }
    };
    const prepareCurrent = async () => {
      await prepareSandboxStateOwnerPath(stateOwnerPath);
      assertCurrent();
    };
    await prepareCurrent();
    return {
      assertCurrent,
      stateOwnerPath,
      prepareCurrent,
    };
  } catch (error) {
    if (error instanceof SandboxStateOwnerRequiredError) {
      throw error;
    }
    throw new SandboxStateOwnerRequiredError(error);
  }
}
