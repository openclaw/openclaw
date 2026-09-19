/**
 * Exec-side glue for secret-assignment authorization.
 *
 * Keeps `bash-tools.exec-run.ts` thin: it wraps the core
 * `authorizeSecretEnvProjection` seam and produces the two things the exec
 * pipeline needs — a denial tool result, or an authorized snapshot plus a
 * spawn-boundary recheck that fails closed on revocation.
 */
import { authorizeSecretEnvProjection } from "../secrets/exec-store-authorize.js";
import type { SecretStoreExecEnvironment } from "../secrets/store/secret-store.js";
import { buildSecretProjectionDeniedToolResult } from "./bash-tools.exec-approval-output.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

export type SecretEnvExecAuthorization = {
  /** Present when the projection was denied; the caller returns it directly. */
  denied?: AgentToolResult<ExecToolDetails>;
  /** The authorized (possibly narrowed) snapshot to project. */
  storeEnv: SecretStoreExecEnvironment;
  /** Spawn-boundary recheck; present only when a policy actually constrained the run. */
  beforeSpawn?: () => Promise<AgentToolResult<ExecToolDetails> | undefined>;
};

/** Authorizes the resolved exec secret projection for one run. */
export async function authorizeSecretEnvForExec(params: {
  storeEnv: SecretStoreExecEnvironment;
  host: "gateway" | "sandbox" | "node";
  workdir?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
}): Promise<SecretEnvExecAuthorization> {
  const result = await authorizeSecretEnvProjection({
    storeEnv: params.storeEnv,
    host: params.host,
    sessionKey: params.sessionKey,
    ctx: {
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    },
  });
  if (!result.ok) {
    return {
      storeEnv: params.storeEnv,
      denied: buildSecretProjectionDeniedToolResult({ cwd: params.workdir }),
    };
  }
  const recheck = result.recheck;
  return {
    storeEnv: result.storeEnv,
    ...(recheck
      ? {
          beforeSpawn: async () => {
            const reason = await recheck();
            return reason
              ? buildSecretProjectionDeniedToolResult({ text: reason, cwd: params.workdir })
              : undefined;
          },
        }
      : {}),
  };
}
