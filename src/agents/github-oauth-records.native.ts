import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import {
  deleteHiddenGitHubSecretInDatabase,
  readHiddenGitHubSecretInDatabase,
} from "../secrets/store/secret-store-hidden-github.kernel.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  githubDeviceRecordName,
  githubOAuthRecordName,
  parseGitHubDeviceAuthorizationRecord,
} from "./github-oauth-records.js";

/** Retained only for the deprecated synchronous Gateway Plugin SDK service. */
export function readGitHubDeviceAuthorizationRecordNative(requestId: string) {
  const name = githubDeviceRecordName(requestId);
  const raw = withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
    readHiddenGitHubSecretInDatabase(db, name, Date.now()),
  );
  if (raw !== undefined) {
    registerSecretValueForRedaction(raw);
  }
  return parseGitHubDeviceAuthorizationRecord(raw, requestId);
}

function remove(name: string) {
  runOpenClawStateWriteTransaction(
    ({ db }) => deleteHiddenGitHubSecretInDatabase(db, name),
    undefined,
    { operationLabel: "secrets.store.delete-hidden-github" },
  );
}

/** Retained only for the deprecated synchronous Gateway Plugin SDK service. */
export function deleteGitHubDeviceAuthorizationRecordNative(requestId: string): void {
  remove(githubDeviceRecordName(requestId));
}

/** Retained only for the deprecated synchronous Gateway Plugin SDK service. */
export function deleteGitHubOAuthRecordNative(profileId: string): void {
  remove(githubOAuthRecordName(profileId));
}
