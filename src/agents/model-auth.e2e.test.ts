import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { ensureAuthProfileStore } from "./auth-profiles.js";
import { getApiKeyForModel, resolveApiKeyForProvider, resolveEnvApiKey } from "./model-auth.js";

const oauthFixture = {
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 60_000,
  accountId: "acct_123",
};

const BEDROCK_PROVIDER_CFG = {
  models: {
    providers: {
      "amazon-bedrock": {
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        api: "bedrock-converse-stream",
        auth: "aws-sdk",
        models: [],
      },
    },
  },
} as const;

async function resolveBedrockProvider() {
  return resolveApiKeyForProvider({
    provider: "amazon-bedrock",
    store: { version: 1, profiles: {} },
    cfg: BEDROCK_PROVIDER_CFG as never,
  });
}

describe("getApiKeyForModel", () => {
  it("migrates legacy oauth.json into auth-profiles.json", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-"));

    try {
      const agentDir = path.join(tempDir, "agent");
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: tempDir,
          OPENCLAW_AGENT_DIR: agentDir,
          PI_CODING_AGENT_DIR: agentDir,
        },
        async () => {
          const oauthDir = path.join(tempDir, "credentials");
          await fs.mkdir(oauthDir, { recursive: true, mode: 0o700 });
          await fs.writeFile(
            path.join(oauthDir, "oauth.json"),
            `${JSON.stringify({ "openai-codex": oauthFixture }, null, 2)}\n`,
            "utf8",
          );

          const model = {
            id: "codex-mini-latest",
            provider: "openai-codex",
            api: "openai-codex-responses",
          } as Model<Api>;

          const store = ensureAuthProfileStore(process.env.OPENCLAW_AGENT_DIR, {
            allowKeychainPrompt: false,
          });
          const apiKey = await getApiKeyForModel({
            model,
            cfg: {
              auth: {
                profiles: {
                  "openai-codex:default": {
                    provider: "openai-codex",
                    mode: "oauth",
                  },
                },
              },
            },
            store,
            agentDir: process.env.OPENCLAW_AGENT_DIR,
          });
          expect(apiKey.apiKey).toBe(oauthFixture.access);

          const authProfiles = await fs.readFile(
            path.join(tempDir, "agent", "auth-profiles.json"),
            "utf8",
          );
          const authData = JSON.parse(authProfiles) as Record<string, unknown>;
          expect(authData.profiles).toMatchObject({
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              access: oauthFixture.access,
              refresh: oauthFixture.refresh,
            },
          });
        },
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("suggests openai-codex when only Codex OAuth is configured", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));

    try {
      const agentDir = path.join(tempDir, "agent");
      await withEnvAsync(
        {
          OPENAI_API_KEY: undefined,
          OPENCLAW_STATE_DIR: tempDir,
          OPENCLAW_AGENT_DIR: agentDir,
          PI_CODING_AGENT_DIR: agentDir,
        },
        async () => {
          const authProfilesPath = path.join(tempDir, "agent", "auth-profiles.json");
          await fs.mkdir(path.dirname(authProfilesPath), {
            recursive: true,
            mode: 0o700,
          });
          await fs.writeFile(
            authProfilesPath,
            `${JSON.stringify(
              {
                version: 1,
                profiles: {
                  "openai-codex:default": {
                    type: "oauth",
                    provider: "openai-codex",
                    ...oauthFixture,
                  },
                },
              },
              null,
              2,
            )}\n`,
            "utf8",
          );

          let error: unknown = null;
          try {
            await resolveApiKeyForProvider({ provider: "openai" });
          } catch (err) {
            error = err;
          }
          expect(String(error)).toContain("openai-codex/gpt-5.3-codex");
        },
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when ZAI API key is missing", async () => {
    await withEnvAsync(
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: undefined,
      },
      async () => {
        let error: unknown = null;
        try {
          await resolveApiKeyForProvider({
            provider: "zai",
            store: { version: 1, profiles: {} },
          });
        } catch (err) {
          error = err;
        }

        expect(String(error)).toContain('No API key found for provider "zai".');
      },
    );
  });

  it("accepts legacy Z_AI_API_KEY for zai", async () => {
    await withEnvAsync(
      {
        ZAI_API_KEY: undefined,
        Z_AI_API_KEY: "zai-test-key",
      },
      async () => {
        const resolved = await resolveApiKeyForProvider({
          provider: "zai",
          store: { version: 1, profiles: {} },
        });
        expect(resolved.apiKey).toBe("zai-test-key");
        expect(resolved.source).toContain("Z_AI_API_KEY");
      },
    );
  });

  it("resolves Synthetic API key from env", async () => {
    await withEnvAsync({ SYNTHETIC_API_KEY: "synthetic-test-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        provider: "synthetic",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("synthetic-test-key");
      expect(resolved.source).toContain("SYNTHETIC_API_KEY");
    });
  });

  it("resolves Qianfan API key from env", async () => {
    await withEnvAsync({ QIANFAN_API_KEY: "qianfan-test-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        provider: "qianfan",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("qianfan-test-key");
      expect(resolved.source).toContain("QIANFAN_API_KEY");
    });
  });

  it("resolves Vercel AI Gateway API key from env", async () => {
    await withEnvAsync({ AI_GATEWAY_API_KEY: "gateway-test-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        provider: "vercel-ai-gateway",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("gateway-test-key");
      expect(resolved.source).toContain("AI_GATEWAY_API_KEY");
    });
  });

  it("prefers Bedrock bearer token over access keys and profile", async () => {
    await withEnvAsync(
      {
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
        AWS_ACCESS_KEY_ID: "access-key",
        AWS_SECRET_ACCESS_KEY: "secret-key",
        AWS_PROFILE: "profile",
      },
      async () => {
        const resolved = await resolveBedrockProvider();

        expect(resolved.mode).toBe("aws-sdk");
        expect(resolved.apiKey).toBeUndefined();
        expect(resolved.source).toContain("AWS_BEARER_TOKEN_BEDROCK");
      },
    );
  });

  it("prefers Bedrock access keys over profile", async () => {
    await withEnvAsync(
      {
        AWS_BEARER_TOKEN_BEDROCK: undefined,
        AWS_ACCESS_KEY_ID: "access-key",
        AWS_SECRET_ACCESS_KEY: "secret-key",
        AWS_PROFILE: "profile",
      },
      async () => {
        const resolved = await resolveBedrockProvider();

        expect(resolved.mode).toBe("aws-sdk");
        expect(resolved.apiKey).toBeUndefined();
        expect(resolved.source).toContain("AWS_ACCESS_KEY_ID");
      },
    );
  });

  it("uses Bedrock profile when access keys are missing", async () => {
    await withEnvAsync(
      {
        AWS_BEARER_TOKEN_BEDROCK: undefined,
        AWS_ACCESS_KEY_ID: undefined,
        AWS_SECRET_ACCESS_KEY: undefined,
        AWS_PROFILE: "profile",
      },
      async () => {
        const resolved = await resolveBedrockProvider();

        expect(resolved.mode).toBe("aws-sdk");
        expect(resolved.apiKey).toBeUndefined();
        expect(resolved.source).toContain("AWS_PROFILE");
      },
    );
  });

  it("accepts VOYAGE_API_KEY for voyage", async () => {
    await withEnvAsync({ VOYAGE_API_KEY: "voyage-test-key" }, async () => {
      const voyage = await resolveApiKeyForProvider({
        provider: "voyage",
        store: { version: 1, profiles: {} },
      });
      expect(voyage.apiKey).toBe("voyage-test-key");
      expect(voyage.source).toContain("VOYAGE_API_KEY");
    });
  });

  it("strips embedded CR/LF from ANTHROPIC_API_KEY", async () => {
    await withEnvAsync({ ANTHROPIC_API_KEY: "sk-ant-test-\r\nkey" }, async () => {
      const resolved = resolveEnvApiKey("anthropic");
      expect(resolved?.apiKey).toBe("sk-ant-test-key");
      expect(resolved?.source).toContain("ANTHROPIC_API_KEY");
    });
  });

  it("resolveEnvApiKey('huggingface') returns HUGGINGFACE_HUB_TOKEN when set", async () => {
    await withEnvAsync(
      {
        HUGGINGFACE_HUB_TOKEN: "hf_hub_xyz",
        HF_TOKEN: undefined,
      },
      async () => {
        const resolved = resolveEnvApiKey("huggingface");
        expect(resolved?.apiKey).toBe("hf_hub_xyz");
        expect(resolved?.source).toContain("HUGGINGFACE_HUB_TOKEN");
      },
    );
  });

  it("resolveEnvApiKey('huggingface') prefers HUGGINGFACE_HUB_TOKEN over HF_TOKEN when both set", async () => {
    await withEnvAsync(
      {
        HUGGINGFACE_HUB_TOKEN: "hf_hub_first",
        HF_TOKEN: "hf_second",
      },
      async () => {
        const resolved = resolveEnvApiKey("huggingface");
        expect(resolved?.apiKey).toBe("hf_hub_first");
        expect(resolved?.source).toContain("HUGGINGFACE_HUB_TOKEN");
      },
    );
  });

  it("resolveEnvApiKey('huggingface') returns HF_TOKEN when only HF_TOKEN set", async () => {
    await withEnvAsync(
      {
        HUGGINGFACE_HUB_TOKEN: undefined,
        HF_TOKEN: "hf_abc123",
      },
      async () => {
        const resolved = resolveEnvApiKey("huggingface");
        expect(resolved?.apiKey).toBe("hf_abc123");
        expect(resolved?.source).toContain("HF_TOKEN");
      },
    );
  });
});
