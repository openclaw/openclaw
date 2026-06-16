// Codex tests cover OpenClaw-owned model catalog provisioning for isolated app-server homes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  buildCodexAppServerModelCatalog,
  CODEX_MODEL_CATALOG_FINGERPRINT_ENV,
  provisionCodexAppServerModelCatalog,
  upsertTopLevelTomlStringAssignment,
} from "./model-catalog-bridge.js";

function createStartOptions(
  overrides: Partial<CodexAppServerStartOptions> = {},
): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command: "codex",
    args: ["app-server"],
    headers: {},
    ...overrides,
  };
}

function createModelCatalogConfig() {
  return {
    models: {
      providers: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
          models: [
            {
              id: "claude-not-for-codex",
              name: "Claude",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200_000,
              maxTokens: 8_192,
            },
          ],
        },
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          models: [
            {
              id: "custom-long-context",
              name: "Custom Long Context",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1_000_000,
              contextTokens: 950_000,
              maxTokens: 128_000,
              compat: {
                supportsTools: true,
                supportedReasoningEfforts: ["minimal", "low", "medium", "high"],
              },
            },
          ],
        },
      },
    },
  };
}

describe("buildCodexAppServerModelCatalog", () => {
  it("materializes configured OpenAI-compatible model metadata for Codex startup", () => {
    const catalog = buildCodexAppServerModelCatalog(createModelCatalogConfig());

    expect(catalog?.models.map((model) => model.slug)).toEqual([
      "custom-long-context",
      "openai/custom-long-context",
    ]);
    expect(catalog?.models[0]).toMatchObject({
      slug: "custom-long-context",
      display_name: "Custom Long Context",
      context_window: 950_000,
      max_context_window: 1_000_000,
      effective_context_window_percent: 95,
      input_modalities: ["text", "image"],
      supports_image_detail_original: true,
      supports_parallel_tool_calls: true,
      supports_reasoning_summaries: true,
      supported_reasoning_levels: [
        { effort: "minimal", description: "minimal" },
        { effort: "low", description: "low" },
        { effort: "medium", description: "medium" },
        { effort: "high", description: "high" },
      ],
    });
    expect(catalog?.models.some((model) => model.slug === "claude-not-for-codex")).toBe(false);
  });

  it("returns undefined when no configured text model can be represented", () => {
    expect(
      buildCodexAppServerModelCatalog({
        models: {
          providers: {
            images: {
              baseUrl: "https://images.example.test",
              api: "openai-responses",
              models: [
                {
                  id: "image-only",
                  name: "Image Only",
                  reasoning: false,
                  input: ["image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8_000,
                  maxTokens: 1_000,
                },
              ],
            },
          },
        },
      }),
    ).toBeUndefined();
  });
});

describe("provisionCodexAppServerModelCatalog", () => {
  it("writes the catalog, upserts config.toml, and fingerprints startup options", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-home-"));
    const startOptions = createStartOptions({ env: { EXISTING: "1" } });
    try {
      await fs.writeFile(path.join(codexHome, "config.toml"), "[features]\nplugins = true\n");

      const resolved = await provisionCodexAppServerModelCatalog({
        startOptions,
        codexHome,
        config: createModelCatalogConfig(),
      });

      const catalogPath = path.join(codexHome, "openclaw-model-catalog.json");
      const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8")) as {
        models?: Array<{ slug?: string; context_window?: number; max_context_window?: number }>;
      };
      expect(catalog.models?.find((model) => model.slug === "custom-long-context")).toMatchObject({
        context_window: 950_000,
        max_context_window: 1_000_000,
      });
      expect(await fs.readFile(path.join(codexHome, "config.toml"), "utf8")).toBe(
        `model_catalog_json = ${JSON.stringify(catalogPath)}\n[features]\nplugins = true\n`,
      );
      expect(resolved.env).toMatchObject({
        EXISTING: "1",
        [CODEX_MODEL_CATALOG_FINGERPRINT_ENV]: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      expect(startOptions.env).toEqual({ EXISTING: "1" });
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });

  it("keeps startup options unchanged when there is no catalog to write", async () => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-home-"));
    const startOptions = createStartOptions();
    try {
      await expect(
        provisionCodexAppServerModelCatalog({
          startOptions,
          codexHome,
          config: {},
        }),
      ).resolves.toBe(startOptions);
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
    }
  });
});

describe("upsertTopLevelTomlStringAssignment", () => {
  it("replaces existing top-level assignments before TOML tables", () => {
    expect(
      upsertTopLevelTomlStringAssignment(
        'model_catalog_json = "/old/catalog.json"\n[features]\nplugins = true\n',
        "model_catalog_json",
        "/new/catalog.json",
      ),
    ).toBe('model_catalog_json = "/new/catalog.json"\n[features]\nplugins = true\n');
  });

  it("inserts top-level assignments ahead of the first TOML table", () => {
    expect(
      upsertTopLevelTomlStringAssignment(
        "[features]\nplugins = true\n",
        "model_catalog_json",
        "/catalog.json",
      ),
    ).toBe('model_catalog_json = "/catalog.json"\n[features]\nplugins = true\n');
  });
});
