import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";

/** Pin an existing inode before preparation yields; the executor owns first creation. */
export function captureAuthProfileWriteExecution(
  target: OpenClawAgentDatabaseOptions & { path: string },
) {
  const identity = readDatabasePathIdentitySync(target.path);
  return captureOpenClawAgentDatabaseExecution(
    target,
    identity.key.startsWith("file:")
      ? {
          expectedIdentity: {
            kind: "file",
            physicalIdentity: identity.key.slice("file:".length),
            nativeLocation: identity.canonicalPath,
            birthtime: identity.birthtime,
          },
        }
      : {},
  );
}
