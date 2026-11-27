import assert from "node:assert/strict";
import path from "node:path";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withEnv } from "../../test-utils/env.js";
import { setRuntimeAuthProfileStoreSnapshot } from "./runtime-snapshots.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreWithoutExternalProfiles,
} from "./store-runtime.js";
import { resolveRuntimeAuthProfileAgentDir, withAuthProfileStoreAgentDir } from "./store.js";
import type { AuthProfileCredential } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const [stateDir, agentDir, laterCwd] = process.argv.slice(2);
assert.ok(
  stateDir && agentDir && laterCwd,
  "Auth scope fixture requires state, agent, and cwd paths",
);
const credential = {
  type: "api_key",
  provider: "openai",
  key: "original",
} satisfies AuthProfileCredential;

try {
  await persistAuthProfileBatch({ stateDir, profiles: [{ profileId: "shared", credential }] });
  await persistAuthProfileBatch({
    stateDir,
    agentDir,
    profiles: [{ profileId: "local", credential: { ...credential, key: "original-local" } }],
  });
  withEnv({ OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined }, () => {
    setRuntimeAuthProfileStoreSnapshot(loadAuthProfileStoreWithoutExternalProfiles());
    setRuntimeAuthProfileStoreSnapshot(
      loadAuthProfileStoreWithoutExternalProfiles(agentDir),
      agentDir,
    );
  });
  const entryCwd = process.cwd();
  const preparing = withAuthProfileStoreAgentDir(
    path.relative(entryCwd, agentDir),
    path.relative(entryCwd, stateDir),
    () => {
      assert.equal(resolveRuntimeAuthProfileAgentDir(), agentDir);
      assert.deepEqual(ensureAuthProfileStoreWithoutExternalProfiles().profiles.shared, credential);
    },
  );
  process.chdir(laterCwd);
  await preparing;
} finally {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
