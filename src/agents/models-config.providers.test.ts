import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("resolveImplicitProviders", () => {
  const previousXaiKey = process.env.XAI_API_KEY;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (previousXaiKey === undefined) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = previousXaiKey;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("includes xai provider when XAI_API_KEY environment variable is set", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-xai-"));

    try {
      process.env.XAI_API_KEY = "xai-implicit-key";
      process.env.OPENCLAW_STATE_DIR = tempDir;
      process.env.OPENCLAW_AGENT_DIR = path.join(tempDir, "agent");

      vi.resetModules();
      const { resolveImplicitProviders } = await import("./models-config.providers.js");

      const providers = await resolveImplicitProviders({
        agentDir: process.env.OPENCLAW_AGENT_DIR,
      });

      expect(providers.xai).toBeDefined();
      expect(providers.xai?.apiKey).toBe("XAI_API_KEY");
      expect(providers.xai?.baseUrl).toBe("https://api.x.ai/v1");
      expect(providers.xai?.api).toBe("openai-completions");
      expect(providers.xai?.models).toHaveLength(5);
    } finally {
      delete process.env.XAI_API_KEY;
    }
  });

  it("includes xai provider when auth profile exists", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-xai-profile-"));

    try {
      delete process.env.XAI_API_KEY;
      process.env.OPENCLAW_STATE_DIR = tempDir;
      process.env.OPENCLAW_AGENT_DIR = path.join(tempDir, "agent");

      const authProfilesDir = process.env.OPENCLAW_AGENT_DIR;
      await fs.mkdir(authProfilesDir, { recursive: true });
      await fs.writeFile(
        path.join(authProfilesDir, "auth-profiles.json"),
        JSON.stringify({
          version: 1,
          profiles: {
            "xai:default": {
              type: "api_key",
              provider: "xai",
              key: "xai-profile-implicit-key",
            },
          },
        }),
        "utf8",
      );

      vi.resetModules();
      const { resolveImplicitProviders } = await import("./models-config.providers.js");

      const providers = await resolveImplicitProviders({
        agentDir: process.env.OPENCLAW_AGENT_DIR,
      });

      expect(providers.xai).toBeDefined();
      // apiKey will be a profile reference, not the actual key
      expect(providers.xai?.apiKey).toBeDefined();
      expect(providers.xai?.baseUrl).toBe("https://api.x.ai/v1");
      expect(providers.xai?.api).toBe("openai-completions");
      expect(providers.xai?.models).toHaveLength(5);
    } finally {
      delete process.env.XAI_API_KEY;
    }
  });

  it("excludes xai provider when no credential available", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-xai-none-"));

    try {
      delete process.env.XAI_API_KEY;
      process.env.OPENCLAW_STATE_DIR = tempDir;
      process.env.OPENCLAW_AGENT_DIR = path.join(tempDir, "agent");

      vi.resetModules();
      const { resolveImplicitProviders } = await import("./models-config.providers.js");

      const providers = await resolveImplicitProviders({
        agentDir: process.env.OPENCLAW_AGENT_DIR,
      });

      expect(providers.xai).toBeUndefined();
    } finally {
      delete process.env.XAI_API_KEY;
    }
  });

  it("xai provider includes all model aliases", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-xai-aliases-"));

    try {
      process.env.XAI_API_KEY = "xai-test-key";
      process.env.OPENCLAW_STATE_DIR = tempDir;
      process.env.OPENCLAW_AGENT_DIR = path.join(tempDir, "agent");

      vi.resetModules();
      const { resolveImplicitProviders } = await import("./models-config.providers.js");

      const providers = await resolveImplicitProviders({
        agentDir: process.env.OPENCLAW_AGENT_DIR,
      });

      expect(providers.xai).toBeDefined();
      const modelIds = providers.xai?.models.map((m) => m.id);
      expect(modelIds).toContain("grok-4-1-fast-reasoning");
      expect(modelIds).toContain("grok-4-1-fast-non-reasoning");
      expect(modelIds).toContain("grok-code-fast-1");
      expect(modelIds).toContain("grok-3");
      expect(modelIds).toContain("grok-3-mini");
    } finally {
      delete process.env.XAI_API_KEY;
    }
  });
});
