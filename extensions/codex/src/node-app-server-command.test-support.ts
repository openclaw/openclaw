import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { readCodexWorkerProvisioningBundle } from "./node-app-server-command.js";

export function useCodexWorkerProvisioningFixture() {
  const roots: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  return () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codex-provisioning-"));
    roots.push(root);
    const directory = path.join(root, "worker-provisioning", "codex");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const helper = path.join(directory, "token.mjs");
    fs.writeFileSync(helper, 'process.stdout.write("synthetic-worker-token")\n', { mode: 0o600 });
    fs.writeFileSync(
      path.join(directory, "config.toml"),
      'model_provider = "worker"\n[model_providers.worker]\nwire_api = "responses"\nauth = { command = "node", args = [' +
        JSON.stringify(helper) +
        "] }\n",
      { mode: 0o600 },
    );
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    return readCodexWorkerProvisioningBundle()!;
  };
}
