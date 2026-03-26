import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveAuthProfileStore } from "./auth-profiles.js";
import { discoverAuthStorage } from "./pi-model-discovery.js";

async function createAgentDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pi-auth-storage-"));
}

async function withAgentDir(run: (agentDir: string) => Promise<void>): Promise<void> {
  const agentDir = await createAgentDir();
  try {
    await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

async function pathExists(pathname: string): Promise<boolean> {
  try {
    await fs.stat(pathname);
    return true;
  } catch {
    return false;
  }
}

function writeRuntimeOpenRouterProfile(agentDir: string): void {
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-or-v1-runtime",
        },
      },
    },
    agentDir,
  );
}

async function writeLegacyAuthJson(
  agentDir: string,
  authEntries: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(path.join(agentDir, "auth.json"), JSON.stringify(authEntries, null, 2));
}

async function readLegacyAuthJson(agentDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(agentDir, "auth.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("discoverAuthStorage", () => {
  it("loads runtime credentials from auth-profiles without writing auth.json", async () => {
    await withAgentDir(async (agentDir) => {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openrouter:default": {
              type: "api_key",
              provider: "openrouter",
              key: "sk-or-v1-runtime",
            },
            "anthropic:default": {
              type: "token",
              provider: "anthropic",
              token: "sk-ant-runtime",
            },
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              access: "oauth-access",
              refresh: "oauth-refresh",
              expires: Date.now() + 60_000,
            },
          },
        },
        agentDir,
      );

      const authStorage = discoverAuthStorage(agentDir);

      expect(authStorage.hasAuth("openrouter")).toBe(true);
      expect(authStorage.hasAuth("anthropic")).toBe(true);
      expect(authStorage.hasAuth("openai-codex")).toBe(true);
      await expect(authStorage.getApiKey("openrouter")).resolves.toBe("sk-or-v1-runtime");
      await expect(authStorage.getApiKey("anthropic")).resolves.toBe("sk-ant-runtime");
      expect(authStorage.get("openai-codex")).toMatchObject({
        type: "oauth",
        access: "oauth-access",
      });

      expect(await pathExists(path.join(agentDir, "auth.json"))).toBe(false);
    });
  });

  it("scrubs static api_key entries from legacy auth.json and keeps oauth entries", async () => {
    await withAgentDir(async (agentDir) => {
      writeRuntimeOpenRouterProfile(agentDir);
      await writeLegacyAuthJson(agentDir, {
        openrouter: { type: "api_key", key: "legacy-static-key" },
        "openai-codex": {
          type: "oauth",
          access: "oauth-access",
          refresh: "oauth-refresh",
          expires: Date.now() + 60_000,
        },
      });

      discoverAuthStorage(agentDir);

      const parsed = await readLegacyAuthJson(agentDir);
      expect(parsed.openrouter).toBeUndefined();
      expect(parsed["openai-codex"]).toMatchObject({
        type: "oauth",
        access: "oauth-access",
      });
    });
  });

  it("preserves legacy auth.json when auth store is forced read-only", async () => {
    await withAgentDir(async (agentDir) => {
      const previous = process.env.OPENCLAW_AUTH_STORE_READONLY;
      process.env.OPENCLAW_AUTH_STORE_READONLY = "1";
      try {
        writeRuntimeOpenRouterProfile(agentDir);
        await writeLegacyAuthJson(agentDir, {
          openrouter: { type: "api_key", key: "legacy-static-key" },
        });

        discoverAuthStorage(agentDir);

        const parsed = await readLegacyAuthJson(agentDir);
        expect(parsed.openrouter).toMatchObject({ type: "api_key", key: "legacy-static-key" });
      } finally {
        if (previous === undefined) {
          delete process.env.OPENCLAW_AUTH_STORE_READONLY;
        } else {
          process.env.OPENCLAW_AUTH_STORE_READONLY = previous;
        }
      }
    });
  });

  it("includes env-backed provider auth when no auth profile exists", async () => {
    await withAgentDir(async (agentDir) => {
      const previous = process.env.MISTRAL_API_KEY;
      process.env.MISTRAL_API_KEY = "mistral-env-test-key";
      try {
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {},
          },
          agentDir,
        );

        const authStorage = discoverAuthStorage(agentDir);

        expect(authStorage.hasAuth("mistral")).toBe(true);
        await expect(authStorage.getApiKey("mistral")).resolves.toBe("mistral-env-test-key");
      } finally {
        if (previous === undefined) {
          delete process.env.MISTRAL_API_KEY;
        } else {
          process.env.MISTRAL_API_KEY = previous;
        }
      }
    });
  });
});
