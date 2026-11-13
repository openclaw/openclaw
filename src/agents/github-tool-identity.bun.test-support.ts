import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative } from "@openclaw/fs-safe/config";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  createManagedGitHubProfileId,
  prepareGitHubPublicationIdentity,
  resolveManagedGitHubProfileDir,
} from "./github-tool-identity.js";

assert.ok(process.versions.bun, "native canonicalization must execute in Bun");
const env = { OPENCLAW_STATE_DIR: process.argv[2] };
const profileId = createManagedGitHubProfileId();
const profileDir = resolveManagedGitHubProfileDir({
  agentId: "synthetic",
  scope: "system",
  profileId,
  env,
});
await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
await fs.writeFile(
  path.join(profileDir, "hosts.yml"),
  "github.com:\n  oauth_token: synthetic-placeholder\n",
  { mode: 0o600 },
);
globalThis.fetch = async () => Response.json({ id: 123, login: "synthetic-account" });
try {
  for (const mode of ["off", "require", "off"] as const) {
    configureFsSafeNative({ mode });
    const available = await prepareGitHubPublicationIdentity({
      config: { tools: { github: { profileId } } },
      agentId: "synthetic",
      env,
    }).then(
      () => true,
      () => false,
    );
    assert.equal(available, mode !== "require", `native policy ${mode}`);
  }
} finally {
  await drainGlobalSingletonLifecycleState();
}
