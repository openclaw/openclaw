import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import { upsertAuthProfile } from "./auth-profiles/profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/store.js";
import { prepareIsolatedCodexRuntimeHome } from "./codex-runtime-home.js";

const runtimeMocks = vi.hoisted(() => ({
  refreshOpenAICodexToken: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: vi.fn(),
  getOAuthProviders: () => [],
  loginOpenAICodex: vi.fn(),
  refreshOpenAICodexToken: runtimeMocks.refreshOpenAICodexToken,
}));

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.unstubAllEnvs();
  runtimeMocks.refreshOpenAICodexToken.mockReset();
});

describe("prepareIsolatedCodexRuntimeHome", () => {
  it("writes a temp auth.json for an OpenAI Codex OAuth profile", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-runtime-home-state-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: {
            version: AUTH_STORE_VERSION,
            profiles: {
              "openai-codex:default": {
                type: "oauth",
                provider: "openai-codex",
                access: "access-token",
                refresh: "refresh-token",
                expires: Date.now() + 60_000,
                accountId: "acct-123",
                idToken: "id-token",
              },
            },
          },
        },
      ]);

      const prepared = await prepareIsolatedCodexRuntimeHome({
        agentDir,
        authProfileId: "openai-codex:default",
        writeAuthJson: true,
      });

      expect(prepared.env.CODEX_HOME).toBe(prepared.codexHome);
      expect(prepared.clearEnv).toEqual(["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"]);
      const raw = await fs.readFile(prepared.authPath!, "utf8");
      expect(JSON.parse(raw)).toMatchObject({
        OPENAI_API_KEY: null,
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          account_id: "acct-123",
          id_token: "id-token",
        },
      });

      await prepared.cleanup();
      await expect(fs.access(prepared.codexHome)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("prefers env auth over auth.json for api-key profiles", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-runtime-home-state-"));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      upsertAuthProfile({
        agentDir,
        profileId: "openai-codex:default",
        credential: {
          type: "api_key",
          provider: "openai-codex",
          key: "sk-openclaw",
        },
      });

      const prepared = await prepareIsolatedCodexRuntimeHome({
        agentDir,
        authProfileId: "openai-codex:default",
        writeAuthJson: true,
      });

      expect(prepared.authPath).toBeUndefined();
      expect(prepared.env.CODEX_API_KEY).toBe("sk-openclaw");
      expect(prepared.env.OPENAI_API_KEY).toBe("sk-openclaw");
      await expect(fs.access(path.join(prepared.codexHome, "auth.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await prepared.cleanup();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
