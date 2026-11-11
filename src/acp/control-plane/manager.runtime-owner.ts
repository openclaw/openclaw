import {
  resolveRuntimeHandleIdentifiersFromIdentity,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type { AcpRuntime, AcpRuntimeHandle } from "@openclaw/acp-core/runtime/types";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { assertNoUnmigratedWorkspaceState } from "../../agents/workspace-legacy-state.js";
import { resolveCanonicalWorkspacePath } from "../../agents/workspace-state-identity.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import {
  findStartupMaintenanceRequiredError,
  StartupMaintenanceRequiredError,
} from "../../infra/startup-maintenance-required.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import type { AcpSessionTarget } from "./manager.types.js";

const log = createSubsystemLogger("acp/control-plane");

/** Old backends can isolate qualified keys, but silently ignore an added owner field. */
export function assertAcpRuntimeOwnerSupport(runtime: AcpRuntime, target: AcpSessionTarget): void {
  if (!parseAgentSessionKey(target.sessionKey) && runtime.ownerAwareSessions !== 1) {
    throw new AcpRuntimeError(
      "ACP_SESSION_INIT_FAILED",
      "This ACP backend cannot isolate bare session keys by owner. Upgrade the backend to support ownerAwareSessions version 1.",
      { detailCode: "SESSION_OWNER_UNSUPPORTED" },
    );
  }
}

/** These operator repairs must never become resume recovery, failover, or a successful reset. */
export function isAcpOwnerRepairRequired(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth++) {
    const detail = "detailCode" in current ? current.detailCode : undefined;
    if (detail === "SESSION_OWNER_MIGRATION_REQUIRED" || detail === "SESSION_OWNER_UNSUPPORTED") {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** Refuse a persisted ACP turn before its prompt reaches an affected workspace. */
export function assertAcpWorkspaceMigrationReady(
  cfg: OpenClawConfig,
  agentId: string,
  handle: AcpRuntimeHandle,
  meta: SessionAcpMeta,
): void {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const managed = resolveCanonicalWorkspacePath(workspaceDir);
  const cwd = handle.cwd ?? meta.runtimeOptions?.cwd ?? meta.cwd;
  const current = cwd && resolveCanonicalWorkspacePath(cwd);
  if (current && !isPathInside(managed, current)) {
    return;
  }
  try {
    assertNoUnmigratedWorkspaceState({ workspaceDir });
    if (cwd && current !== managed) {
      assertNoUnmigratedWorkspaceState({ workspaceDir: cwd });
    }
  } catch (error) {
    if (findStartupMaintenanceRequiredError(error)?.kind !== "legacy-workspace") {
      throw error;
    }
    log.warn("ACP working directory needs workspace state repair", { error: String(error) });
    throw new StartupMaintenanceRequiredError(
      "legacy-workspace",
      "The ACP working directory needs repair. Ask the gateway operator to inspect its path in the Gateway log. Run `openclaw doctor --fix` after ensuring that directory is configured as a workspace.",
    );
  }
}

export function persistedAcpRuntimeHandle(
  target: AcpSessionTarget,
  meta: SessionAcpMeta,
): AcpRuntimeHandle {
  const identity = resolveSessionIdentityFromMeta(meta);
  return {
    sessionKey: target.sessionKey,
    agentId: target.agentId,
    backend: meta.backend,
    runtimeSessionName: meta.runtimeSessionName,
    cwd: meta.cwd,
    acpxRecordId: identity?.acpxRecordId,
    ...resolveRuntimeHandleIdentifiersFromIdentity(identity),
  };
}
