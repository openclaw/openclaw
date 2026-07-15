import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { loadMatrixCredentials, resolveMatrixCredentialsPath } from "./credentials.js";

function setupLegacyCredentialsFile(params: { accountId: string }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-edge-repro-"));
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
      accessToken: "legacy-token-edge",
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

describe("repro_1_3_edge: migration error handling", () => {
  it("migrates legacy credentials using copy + unlink when renameSync throws EXDEV", () => {
    const { stateDir, legacyPath, currentPath } = setupLegacyCredentialsFile({
      accountId: "ops",
    });

    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err = new Error("Cross-device link") as any;
      err.code = "EXDEV";
      throw err;
    });

    try {
      const loaded = loadMatrixCredentials({}, "ops");

      expect(loaded?.accessToken).toBe("legacy-token-edge");
      expect(fs.existsSync(legacyPath)).toBe(false);
      expect(fs.existsSync(currentPath)).toBe(true);
    } finally {
      renameSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not delete legacy credentials file if renameSync throws an unrelated error (e.g. EPERM)", () => {
    const { stateDir, legacyPath, currentPath } = setupLegacyCredentialsFile({
      accountId: "ops",
    });

    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err = new Error("Permission denied") as any;
      err.code = "EPERM";
      throw err;
    });

    try {
      const loaded = loadMatrixCredentials({}, "ops");

      // Even if migration fails, it should still return the loaded legacy credentials
      expect(loaded?.accessToken).toBe("legacy-token-edge");
      // But the legacy file must not be removed, and currentPath must not be created
      expect(fs.existsSync(legacyPath)).toBe(true);
      expect(fs.existsSync(currentPath)).toBe(false);
    } finally {
      renameSpy.mockRestore();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
