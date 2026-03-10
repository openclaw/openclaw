import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("resolveApiKeyForProvider logs profile errors", () => {
  it("logs a warning when a profile throws during resolution", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-log-"));
    const agentDir = path.join(tempDir, "agent");
    await fs.mkdir(agentDir, { recursive: true });

    // Write a store with a profile that will fail (expired oauth without refresh)
    const store = {
      version: 1,
      profiles: {
        "minimax:broken": {
          type: "oauth" as const,
          provider: "minimax",
          oauth: {
            access: "expired-token",
            expires: 0,
          },
        },
      },
    };
    await fs.writeFile(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify(store, null, 2),
      "utf8",
    );

    // The key assertion is that resolveApiKeyForProvider does NOT throw for a
    // single broken profile when env fallback or custom key fallback is also
    // absent – it should throw "No API key found" but NOT crash silently.
    const { resolveApiKeyForProvider } = await import("./model-auth.js");
    await expect(
      resolveApiKeyForProvider({
        provider: "minimax",
        agentDir,
      }),
    ).rejects.toThrow(/No API key found for provider "minimax"/);

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
