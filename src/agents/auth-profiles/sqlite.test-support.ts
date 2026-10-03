import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import type { ApiKeyCredential, AuthProfileStore } from "./types.js";

export function apiKeyCredential(key: string): ApiKeyCredential {
  return { type: "api_key", provider: "openai", key };
}

export function apiKeyStore(key: string): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:default": apiKeyCredential(key),
    },
  };
}

export async function withAgentDirEnv(
  prefix: string,
  run: (agentDir: string, stateDir: string) => void | Promise<void>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const agentDir = path.join(root, "agents", "main", "agent");
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    await withEnvAsync(
      {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_AGENT_DIR: agentDir,
      },
      async () => await run(agentDir, root),
    );
  } finally {
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
