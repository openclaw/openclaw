import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { loadMatrixCredentials, resolveMatrixCredentialsPath } from "./credentials.js";

function setupLegacyCredentialsFile(params: { accountId: string }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-happy-repro-"));
  installMatrixTestRuntime({
    cfg: {
      channels: {
        matrix: {
          accounts: {
            [params.accountId]: {},
          },
        },
      },
    },
    stateDir,
  });

  const legacyPath = path.join(stateDir, "credentials", "matrix", "credentials.json");
  const currentPath = resolveMatrixCredentialsPath({}, params.accountId);

  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(
    legacyPath,
    JSON.stringify({
      homeserver: "https://matrix.example.org",
      userId: `@bot:${params.accountId}.org`,
      accessToken: "legacy-token-12345",
      createdAt: new Date().toISOString(),
    }),
    "utf-8",
  );

  return {
    stateDir,
    legacyPath,
    currentPath,
  };
}

describe("repro_1_3_happy: normal legacy migration", () => {
  it("migrates legacy credentials successfully when renameSync succeeds", () => {
    const { stateDir, legacyPath, currentPath } = setupLegacyCredentialsFile({
      accountId: "ops",
    });

    try {
      const loaded = loadMatrixCredentials({}, "ops");

      expect(loaded?.accessToken).toBe("legacy-token-12345");
      expect(fs.existsSync(legacyPath)).toBe(false);
      expect(fs.existsSync(currentPath)).toBe(true);

      const saved = JSON.parse(fs.readFileSync(currentPath, "utf-8"));
      expect(saved.accessToken).toBe("legacy-token-12345");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
