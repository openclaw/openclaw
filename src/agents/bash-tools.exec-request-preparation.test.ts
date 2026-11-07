// Pins how the prepared exec environment treats inherited (process.env) values, including
// the skill-injected values that `applySkillEnvOverrides` places in process.env (#31583).
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { resolvePreparedExecEnvironment } from "./bash-tools.exec-request-preparation.js";

describe("resolvePreparedExecEnvironment inherited env", () => {
  it("forwards inherited process env values to gateway exec children", () => {
    withEnv(
      {
        GOG_ACCOUNT: "user@example.com",
        GOG_KEYRING_PASSWORD: "keyring-pass", // pragma: allowlist secret
      },
      () => {
        const { env } = resolvePreparedExecEnvironment({
          execParams: { command: "gog calendar events" },
          host: "gateway",
          defaultPathPrepend: [],
          warnings: [],
        });

        expect(env.GOG_ACCOUNT).toBe("user@example.com");
        expect(env.GOG_KEYRING_PASSWORD).toBe("keyring-pass"); // pragma: allowlist secret
      },
    );
  });

  it("keeps inherited process env values out of sandbox exec children", () => {
    withEnv(
      {
        GOG_ACCOUNT: "user@example.com",
        GOG_KEYRING_PASSWORD: "keyring-pass", // pragma: allowlist secret
      },
      () => {
        const warnings: string[] = [];
        const { env } = resolvePreparedExecEnvironment({
          execParams: { command: "gog calendar events" },
          host: "sandbox",
          sandbox: {
            containerName: "openclaw-test-sandbox",
            workspaceDir: "/tmp/openclaw-test-workspace",
            containerWorkdir: "/workspace",
          },
          defaultPathPrepend: [],
          warnings,
        });

        expect(env.GOG_ACCOUNT).toBeUndefined();
        expect(env.GOG_KEYRING_PASSWORD).toBeUndefined(); // pragma: allowlist secret
      },
    );
  });
});
