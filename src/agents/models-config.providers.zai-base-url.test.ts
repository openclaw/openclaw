import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { MoltbotConfig } from "../config/config.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "moltbot-zai-baseurl-" });
}

describe("models-config: ZAI_BASE_URL", () => {
  let prevHome: string | undefined;
  let prevZaiBaseUrl: string | undefined;
  let prevZaiLegacyBaseUrl: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevZaiBaseUrl = process.env.ZAI_BASE_URL;
    prevZaiLegacyBaseUrl = process.env.Z_AI_BASE_URL;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    if (prevZaiBaseUrl === undefined) delete process.env.ZAI_BASE_URL;
    else process.env.ZAI_BASE_URL = prevZaiBaseUrl;
    if (prevZaiLegacyBaseUrl === undefined) delete process.env.Z_AI_BASE_URL;
    else process.env.Z_AI_BASE_URL = prevZaiLegacyBaseUrl;
  });

  it("writes providers.zai.baseUrl from ZAI_BASE_URL (normalized)", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      process.env.ZAI_BASE_URL = "https://proxy.example.test/v1/";
      delete process.env.Z_AI_BASE_URL;

      const { ensureMoltbotModelsJson } = await import("./models-config.js");
      const { resolveMoltbotAgentDir } = await import("./agent-paths.js");

      await ensureMoltbotModelsJson({} as MoltbotConfig);

      const raw = await fs.readFile(path.join(resolveMoltbotAgentDir(), "models.json"), "utf8");
      const parsed = JSON.parse(raw) as { providers?: Record<string, { baseUrl?: string }> };
      expect(parsed.providers?.zai?.baseUrl).toBe("https://proxy.example.test/v1");
    });
  });

  it("supports legacy Z_AI_BASE_URL when ZAI_BASE_URL is unset", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      delete process.env.ZAI_BASE_URL;
      process.env.Z_AI_BASE_URL = "http://localhost:9999/v1/";

      const { ensureMoltbotModelsJson } = await import("./models-config.js");
      const { resolveMoltbotAgentDir } = await import("./agent-paths.js");

      await ensureMoltbotModelsJson({} as MoltbotConfig);

      const raw = await fs.readFile(path.join(resolveMoltbotAgentDir(), "models.json"), "utf8");
      const parsed = JSON.parse(raw) as { providers?: Record<string, { baseUrl?: string }> };
      expect(parsed.providers?.zai?.baseUrl).toBe("http://localhost:9999/v1");
    });
  });
});
