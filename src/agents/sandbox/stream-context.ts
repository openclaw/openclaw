import type { SessionEntry } from "../../config/sessions/types.js";
import type { CronStreamSandboxTarget } from "../../cron/stream-sandbox-target.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { getSandboxPersistentExecCapability } from "./persistent-exec.types.js";
import type { SandboxContext } from "./types.js";

type StreamSandboxContext = {
  agentId: string;
  scopeKey: string;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  assertCurrent?: () => void;
};

const contexts = new WeakMap<SandboxContext, StreamSandboxContext>();

/** Only the sandbox provisioning owner can supply persistent execution's logical target. */
export function bindStreamSandboxContext(
  sandbox: SandboxContext,
  context: StreamSandboxContext,
): void {
  contexts.set(sandbox, context);
}

export function readStreamSandboxContext(
  sandbox: SandboxContext,
): StreamSandboxContext & { configLabel: string } {
  const context = contexts.get(sandbox);
  const configLabel =
    sandbox.backend && getSandboxPersistentExecCapability(sandbox.backend)?.configHash;
  if (!context || sandbox.backendId !== "docker" || !configLabel) {
    throw new Error("Persistent streams require an admitted Docker sandbox context.");
  }
  context.assertCurrent?.();
  context.operatorAuthority?.assertCurrent();
  return { ...context, configLabel };
}

export function captureCronStreamSandboxTarget(params: {
  sandbox: SandboxContext;
  agentId: string;
  sessionKey: string;
  entry: SessionEntry;
}): CronStreamSandboxTarget {
  const { sandbox, entry } = params;
  const context = readStreamSandboxContext(sandbox);
  if (context.agentId !== params.agentId || sandbox.sessionKey !== params.sessionKey) {
    throw new Error("The stream's creator session does not own this sandbox context.");
  }
  const authority = context.operatorAuthority;
  const operator = (() => {
    if (!authority) {
      return undefined;
    }
    if (authority.gatewayAccessGrant === undefined || !authority.readCurrentRoleFacts) {
      throw new Error("This sandbox's original access cannot be resumed for a persistent stream.");
    }
    const roleFacts = authority.readCurrentRoleFacts();
    return {
      profileId: authority.profileId,
      scopes: [...authority.scopes],
      assignedRole: roleFacts.assignedRole,
      githubLogin: roleFacts.githubLogin ?? null,
      gatewayAccessGrant: authority.gatewayAccessGrant,
    };
  })();
  return {
    version: 1,
    backendId: "docker",
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: entry.sessionId,
    ...(entry.lifecycleRevision ? { lifecycleRevision: entry.lifecycleRevision } : {}),
    scopeKey: context.scopeKey,
    workspaceDir: sandbox.workspaceDir,
    agentWorkspaceDir: sandbox.agentWorkspaceDir,
    workspaceAccess: sandbox.workspaceAccess,
    containerWorkdir: sandbox.containerWorkdir,
    ...(sandbox.workspaceSource ? { workspaceSource: sandbox.workspaceSource } : {}),
    configLabel: context.configLabel,
    ...(operator ? { operator } : {}),
  };
}
