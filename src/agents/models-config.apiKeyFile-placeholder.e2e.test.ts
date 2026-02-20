import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  installModelsConfigTestHooks,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

installModelsConfigTestHooks();

describe("models-config with apiKeyFile", () => {
  let tmpDir: string;
  let keyFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-apiKeyFile-"));
    keyFile = path.join(tmpDir, "api-key");
    fs.writeFileSync(keyFile, "sk-from-file-12345\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes placeholder apiKey to models.json when apiKeyFile is set", async () => {
    await withTempHome(async () => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            custom: {
              baseUrl: "https://api.example.com",
              apiKeyFile: keyFile,
              models: [
                {
                  id: "test-model",
                  name: "Test Model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 2048,
                },
              ],
            },
          },
        },
      };

      await ensureOpenClawModelsJson(cfg);

      const modelPath = path.join(resolveOpenClawAgentDir(), "models.json");
      const raw = await fsp.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { apiKey?: string; apiKeyFile?: string }>;
      };

      // models.json gets a placeholder, not the real secret
      expect(parsed.providers.custom?.apiKey).toBe("__apiKeyFile__");
      // apiKeyFile path is preserved so runtime resolution works
      expect(parsed.providers.custom?.apiKeyFile).toBe(keyFile);
      // the actual secret never appears in the file
      expect(raw).not.toContain("sk-from-file-12345");
    });
  });
});
