// Reproduction for #95895: Config-secretref provider API keys (e.g. GEMINI_API_KEY)
// must be managed via OPENCLAW_SERVICE_MANAGED_ENV_KEYS in generated gateway
// service files, not written as plaintext literals.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildGatewayInstallPlan } from "../../src/commands/daemon-install-helpers.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

async function main() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-repro-95895-config-"));
  const nodePath = process.execPath;
  const wrapperPath = path.resolve(repoRoot, "openclaw.mjs");

  try {
    const plan = await buildGatewayInstallPlan({
      env: {
        HOME: tmpHome,
        GEMINI_API_KEY: "sk-gemini-config-secretref-95895", // pragma: allowlist secret
        PATH: process.env.PATH,
      },
      port: 18789,
      runtime: "node",
      nodePath,
      wrapperPath,
      devMode: true,
      platform: process.platform,
      config: {
        models: {
          providers: {
            google: {
              apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" },
            },
          },
        },
      },
    });

    const managedKeys = plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS;
    const geminiInline = plan.environment.GEMINI_API_KEY;

    console.log("=== Reproduction for issue #95895 (config SecretRef) ===");
    console.log(`OPENCLAW_SERVICE_MANAGED_ENV_KEYS=${managedKeys ?? "(missing)"}`);
    console.log(`GEMINI_API_KEY inline=${geminiInline ?? "(not inline - good)"}`);

    const isManaged =
      typeof managedKeys === "string" &&
      managedKeys
        .split(",")
        .map((k) => k.trim())
        .includes("GEMINI_API_KEY");

    if (!isManaged) {
      console.error("FAIL: GEMINI_API_KEY from a config SecretRef is not managed.");
      process.exitCode = 1;
      return;
    }
    if (geminiInline !== undefined) {
      console.error("FAIL: GEMINI_API_KEY is still written as a plaintext literal.");
      process.exitCode = 1;
      return;
    }

    console.log("PASS: Config-secretref GEMINI_API_KEY is managed, not written as plaintext.");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
