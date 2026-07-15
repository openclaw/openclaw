import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { loadMatrixCredentials, resolveMatrixCredentialsPath } from "./credentials.js";

function setupLegacyCredentialsFile(params: { accountId: string }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-stress-repro-"));
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
      accessToken: "legacy-token-stress",
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

describe("repro_1_3_stress: concurrent legacy migration", () => {
  it("handles concurrent migration requests gracefully without crashing", async () => {
    const { stateDir, legacyPath, currentPath } = setupLegacyCredentialsFile({
      accountId: "ops",
    });

    // Mock renameSync to throw EXDEV so we run the copy+unlink path
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err = new Error("Cross-device link") as any;
      err.code = "EXDEV";
      throw err;
    });

    try {
      // Run 20 concurrent loads
      const promises = Array.from({ length: 20 }).map(async () => {
        return loadMatrixCredentials({}, "ops");
      });

      const results = await Promise.all(promises);

      // All of them should successfully return the legacy token
      for (const res of results) {
        expect(res?.accessToken).toBe("legacy-token-stress");
      }

      // Legacy file should be unlinked, and currentPath should exist
      expect(fs.existsSync(legacyPath)).toBe(false);
      expect(fs.existsSync(currentPath)).toBe(true);
    } finally {
      renameSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
