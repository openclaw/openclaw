import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
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

function captureBedrockEnv() {
  return {
    bearer: process.env.AWS_BEARER_TOKEN_BEDROCK,
    access: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
    profile: process.env.AWS_PROFILE,
  };
}

function restoreBedrockEnv(previous: ReturnType<typeof captureBedrockEnv>) {
  if (previous.bearer === undefined) {
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  } else {
    process.env.AWS_BEARER_TOKEN_BEDROCK = previous.bearer;
  }
  if (previous.access === undefined) {
    delete process.env.AWS_ACCESS_KEY_ID;
  } else {
    process.env.AWS_ACCESS_KEY_ID = previous.access;
  }
  if (previous.secret === undefined) {
    delete process.env.AWS_SECRET_ACCESS_KEY;
  } else {
    process.env.AWS_SECRET_ACCESS_KEY = previous.secret;
  }
  if (previous.profile === undefined) {
    delete process.env.AWS_PROFILE;
  } else {
    process.env.AWS_PROFILE = previous.profile;
  }
}

async function resolveBedrockProvider() {
  return resolveApiKeyForProvider({
    provider: "amazon-bedrock",
    store: { version: 1, profiles: {} },
    cfg: BEDROCK_PROVIDER_CFG as never,
  });
}

async function withEnvUpdates<T>(
  updates: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const snapshot = captureEnv(Object.keys(updates));
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await run();
  } finally {
    snapshot.restore();
  }
}

describe("getApiKeyForModel", () => {
  it("migrates legacy oauth.json into auth-profiles.json", async () => {
    const envSnapshot = captureEnv([
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
    ]);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-"));

    try {
      process.env.OPENCLAW_STATE_DIR = tempDir;
      process.env.OPENCLAW_AGENT_DIR = path.join(tempDir, "agent");
      process.env.PI_CODING_AGENT_DIR = process.env.OPENCLAW_AGENT_DIR;

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
    } finally {
      envSnapshot.restore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("suggests openai-codex when only Codex OAuth is configured", async () => {
    const envSnapshot = captureEnv([
      "OPENAI_API_KEY",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
    ]);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));

    try {
      delete process.env.OPENAI_API_KEY;
      process.env.OPENCLAW_STATE_DIR = tempDir;
      process.env.OPENCLAW_AGENT_DIR = path.join(tempDir, "agent");
      process.env.PI_CODING_AGENT_DIR = process.env.OPENCLAW_AGENT_DIR;

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
    } finally {
      envSnapshot.restore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when ZAI API key is missing", async () => {
    await withEnvUpdates(
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
    await withEnvUpdates(
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
    await withEnvUpdates({ SYNTHETIC_API_KEY: "synthetic-test-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        provider: "synthetic",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("synthetic-test-key");
      expect(resolved.source).toContain("SYNTHETIC_API_KEY");
    });
  });

  it("resolves Qianfan API key from env", async () => {
    await withEnvUpdates({ QIANFAN_API_KEY: "qianfan-test-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        provider: "qianfan",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("qianfan-test-key");
      expect(resolved.source).toContain("QIANFAN_API_KEY");
    });
  });

  it("resolves Vercel AI Gateway API key from env", async () => {
    await withEnvUpdates({ AI_GATEWAY_API_KEY: "gateway-test-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        provider: "vercel-ai-gateway",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("gateway-test-key");
      expect(resolved.source).toContain("AI_GATEWAY_API_KEY");
    });
  });

  it("prefers Bedrock bearer token over access keys and profile", async () => {
    const previous = captureBedrockEnv();

    try {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-token";
      process.env.AWS_ACCESS_KEY_ID = "access-key";
      process.env.AWS_SECRET_ACCESS_KEY = "secret-key";
      process.env.AWS_PROFILE = "profile";

      const resolved = await resolveBedrockProvider();

      expect(resolved.mode).toBe("aws-sdk");
      expect(resolved.apiKey).toBeUndefined();
      expect(resolved.source).toContain("AWS_BEARER_TOKEN_BEDROCK");
    } finally {
      restoreBedrockEnv(previous);
    }
  });

  it("prefers Bedrock access keys over profile", async () => {
    const previous = captureBedrockEnv();

    try {
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      process.env.AWS_ACCESS_KEY_ID = "access-key";
      process.env.AWS_SECRET_ACCESS_KEY = "secret-key";
      process.env.AWS_PROFILE = "profile";

      const resolved = await resolveBedrockProvider();

      expect(resolved.mode).toBe("aws-sdk");
      expect(resolved.apiKey).toBeUndefined();
      expect(resolved.source).toContain("AWS_ACCESS_KEY_ID");
    } finally {
      restoreBedrockEnv(previous);
    }
  });

  it("uses Bedrock profile when access keys are missing", async () => {
    const previous = captureBedrockEnv();

    try {
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      process.env.AWS_PROFILE = "profile";

      const resolved = await resolveBedrockProvider();

      expect(resolved.mode).toBe("aws-sdk");
      expect(resolved.apiKey).toBeUndefined();
      expect(resolved.source).toContain("AWS_PROFILE");
    } finally {
      restoreBedrockEnv(previous);
    }
  });

  it("accepts VOYAGE_API_KEY for voyage", async () => {
    await withEnvUpdates({ VOYAGE_API_KEY: "voyage-test-key" }, async () => {
      const resolved = await resolveApiKeyForProvider({
        provider: "voyage",
        store: { version: 1, profiles: {} },
      });
      expect(resolved.apiKey).toBe("voyage-test-key");
      expect(resolved.source).toContain("VOYAGE_API_KEY");
    });
  });

  it("strips embedded CR/LF from ANTHROPIC_API_KEY", async () => {
    await withEnvUpdates({ ANTHROPIC_API_KEY: "sk-ant-test-\r\nkey" }, async () => {
      const resolved = resolveEnvApiKey("anthropic");
      expect(resolved?.apiKey).toBe("sk-ant-test-key");
      expect(resolved?.source).toContain("ANTHROPIC_API_KEY");
    });
  });

  it("resolveEnvApiKey('huggingface') returns HUGGINGFACE_HUB_TOKEN when set", async () => {
    await withEnvUpdates(
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
    await withEnvUpdates(
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
    await withEnvUpdates(
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
