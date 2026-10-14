import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { resolveEnvApiKey } from "./model-auth-env.js";
import {
  hasAvailableAuthForProvider,
  resolveApiKeyForProviderCore,
  resolveModelAuthMode,
} from "./model-auth.js";
import { createProviderAuthChecker } from "./model-provider-auth.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeWorkspaceAuthEvidencePlugin(workspaceDir: string) {
  const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "workspace-cloud");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "index.ts"), "export default {}\n", "utf8");
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "workspace-cloud",
      configSchema: { type: "object" },
      setup: {
        providers: [
          {
            id: "workspace-cloud",
            authEvidence: [
              {
                type: "local-file-with-env",
                fileEnvVar: "WORKSPACE_CLOUD_CREDENTIALS",
                credentialMarker: "workspace-cloud-local-credentials",
                source: "workspace cloud credentials",
              },
            ],
          },
        ],
      },
    }),
    "utf8",
  );
}

describe("workspace plugin model auth evidence", () => {
  it("uses trusted workspace plugin auth evidence across runtime and picker auth checks", async () => {
    // Workspace scope is required for this plugin-owned marker.
    const tempRoot = tempDirs.make("openclaw-workspace-auth-");
    const workspaceDir = path.join(tempRoot, "workspace");
    const bundledDir = path.join(tempRoot, "bundled");
    const stateDir = path.join(tempRoot, "state");
    const credentialsPath = path.join(tempRoot, "credentials.json");
    await fs.mkdir(bundledDir, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(credentialsPath, "{}", "utf8");
    await writeWorkspaceAuthEvidencePlugin(workspaceDir);

    const cfg: OpenClawConfig = {
      plugins: {
        allow: ["workspace-cloud"],
      },
    };
    const store: AuthProfileStore = { version: 1, profiles: {} };

    await withEnvAsync(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_STATE_DIR: stateDir,
        WORKSPACE_CLOUD_CREDENTIALS: credentialsPath,
      },
      async () => {
        expect(resolveEnvApiKey("workspace-cloud", process.env, { config: cfg })).toBeNull();
        expect(
          resolveEnvApiKey("workspace-cloud", process.env, {
            config: cfg,
            workspaceDir,
          }),
        ).toEqual({
          apiKey: "workspace-cloud-local-credentials",
          source: "workspace cloud credentials",
        });
        await expect(
          resolveApiKeyForProviderCore({
            provider: "workspace-cloud",
            cfg,
            workspaceDir,
            store,
          }),
        ).resolves.toEqual({
          apiKey: "workspace-cloud-local-credentials",
          source: "workspace cloud credentials",
          mode: "api-key",
        });
        expect(resolveModelAuthMode("workspace-cloud", cfg, store, { workspaceDir })).toBe(
          "api-key",
        );
        await expect(
          hasAvailableAuthForProvider({
            provider: "workspace-cloud",
            cfg,
            workspaceDir,
            store,
          }),
        ).resolves.toBe(true);
        await expect(
          createProviderAuthChecker({
            cfg,
            workspaceDir,
            agentDir: path.join(stateDir, "agent"),
          })("workspace-cloud", { modelId: "fixture-model" }),
        ).resolves.toBe(true);
      },
    );
  });
});
