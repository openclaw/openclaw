import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { beginAuthProfileCredentialBatch } from "../../state/user-model-account-authority.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import { writeAuthProfileJsonCell } from "./sqlite-json-write.js";
import { runAuthProfileWriteTransaction } from "./sqlite.js";
import { loadAuthProfileStoreWithoutExternalProfilesAsync } from "./store-runtime.js";

const dirs = createTempDirTracker();
const databases: string[] = [];
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  for (const pathname of databases) {
    await closeOpenClawStateDatabaseByPathAsync(pathname);
  }
  dirs.cleanup();
});

const profileId = "openai:token-sharing:fixture";

// Setup checks a just-saved Sign in with ChatGPT login while the Gateway's catalog publishes it.
it.each([
  { settles: true, outcome: { apiKey: "synthetic-access" } },
  { settles: false, outcome: { error: "authority is unavailable" } },
])("reads a ChatGPT login whose publication settles=$settles", async ({ settles, outcome }) => {
  const stateDir = dirs.make("oauth-publication-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined };
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_AGENT_DIR", undefined);
  const shared = openOpenClawStateDatabase({ env });
  databases.push(shared.path);
  runAuthProfileWriteTransaction(
    undefined,
    ({ db }) =>
      writeAuthProfileJsonCell(db, "store", "shared-state", {
        version: 1,
        profiles: {
          [profileId]: {
            type: "oauth",
            provider: "openai",
            access: "synthetic-access",
            refresh: "synthetic-refresh",
            expires: Date.now() + 3_600_000,
            authFlow: "chatgpt-token-sharing",
          },
        },
      }),
    { env },
  );
  const store = await loadAuthProfileStoreWithoutExternalProfilesAsync(undefined);
  const catalog = beginAuthProfileCredentialBatch(
    captureOpenClawStateWorkerContext({ env, path: shared.path }),
  );
  const resolving = resolveApiKeyForProfile({ cfg: {}, store, profileId });
  setTimeout(() => catalog.finish(settles), 50);
  const result = await resolving.then(
    (resolved) => ({ apiKey: resolved?.apiKey }),
    (error: unknown) => ({ error: String(error) }),
  );
  if ("error" in outcome) {
    expect(result).toEqual({ error: expect.stringContaining(outcome.error) });
  } else {
    expect(result).toEqual(outcome);
  }
});
