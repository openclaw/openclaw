import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { toAgentExecutionConstraints } from "../../state/openclaw-agent-execution-scope.js";
import {
  captureOpenClawAgentDatabaseExecution,
  captureOpenClawAgentDatabaseExecutionAsync,
} from "../../state/openclaw-agent-execution.js";

/** Candidates already pin their source; async admission must not adopt a replacement file. */
export async function captureAuthProfileCandidateWriteExecution(
  target: Parameters<typeof captureAuthProfileWriteExecution>[0],
) {
  const execution = await captureOpenClawAgentDatabaseExecutionAsync(target);
  const expected = target.identity;
  if (
    expected?.key.startsWith("file:") &&
    (execution.capturedIdentity.key !== expected.key ||
      execution.capturedIdentity.birthtime !== expected.birthtime)
  ) {
    await execution.release();
    throw new Error("Auth candidate database identity changed before write admission");
  }
  return execution;
}

/** Pin an existing inode before preparation yields; the executor owns first creation. */
export function captureAuthProfileWriteExecution(
  target: OpenClawAgentDatabaseOptions & { path: string; identity?: DatabasePathIdentity },
) {
  const identity = target.identity ?? readDatabasePathIdentitySync(target.path);
  return captureOpenClawAgentDatabaseExecution(
    target,
    identity.key.startsWith("file:") ? toAgentExecutionConstraints(identity) : {},
  );
}
