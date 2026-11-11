import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { captureAuthProfileCredentialAuthority } from "../../state/user-model-account-authority.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { captureAuthProfileStorePersistenceSnapshot } from "./store.js";

export function retainPersistedCredential(agentDir: string, selectedProfileId: string) {
  const shared = openOpenClawStateDatabase();
  const { databasePath } = captureAuthProfileStorePersistenceSnapshot(agentDir).owner;
  const source = readDatabasePathIdentitySync(databasePath);
  const authority = captureAuthProfileCredentialAuthority(
    captureOpenClawStateWorkerContext({ path: shared.path }),
    { databasePath, identity: `${source.key}:${source.birthtime ?? ""}` },
    selectedProfileId,
  );
  authority.observe(loadPersistedAuthProfileStore(agentDir)?.profiles[selectedProfileId]);
  return authority;
}
