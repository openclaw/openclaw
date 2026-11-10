import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it, vi } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { LLAMA_SERVER_RELEASE, selectLlamaServerAsset } from "./src/llama-server-assets.js";

// mock-isolation: Resource ownership comes from the host; no real state is inspected or written.
vi.mock("openclaw/plugin-sdk/state-paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/state-paths")>()),
  resolveManagedResourceStateDir: () => path.resolve("/fixture/operator"),
}));

const root = path.resolve("/fixture/operator/tools/llama.cpp");
const asset = selectLlamaServerAsset();
const installation = `${process.platform}-${process.arch}`;
const oldCommand = path.join(root, "b10809", installation, asset.executable);
const currentCommand = path.join(root, LLAMA_SERVER_RELEASE, installation, asset.executable);
const legacyModel =
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";
const config = (command: string): OpenClawConfig => ({
  memory: { search: { provider: "local", local: { modelPath: "/models/explicit.gguf" } } },
  models: {
    providers: {
      "llama-cpp": {
        baseUrl: "http://127.0.0.1:19432/v1",
        models: [],
        localService: {
          command,
          args: ["--models-preset", "/fixture/models.ini"],
          env: { FLAG: "1" },
        },
      },
    },
  },
});

it("migrates the shipped runtime without changing model choices or service settings", () => {
  const cfg = config(oldCommand);
  expect(legacyConfigRules[0]!.match(oldCommand)).toBe(true);
  const result = normalizeCompatibilityConfig({ cfg });
  expect(result.config).toEqual(config(currentCommand));
  expect(cfg).toEqual(config(oldCommand));
  expect(result.changes).toHaveLength(1);
  expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
    config: result.config,
    changes: [],
  });
});

it.each([
  path.join(root, "b1", installation, asset.executable),
  path.join(root, "b10809", "another-host", asset.executable),
  path.join(root, "b10809", installation, "custom-server"),
  path.join(root, "custom", asset.executable),
  path.join(root, "..", "other-state", "b10809", installation, asset.executable),
  currentCommand,
])("preserves a command not owned by this migration: %s", (command) => {
  const cfg = config(command);
  expect(legacyConfigRules[0]!.match(command)).toBe(false);
  expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
});

it.each([oldCommand, currentCommand, "/custom/llama-server"])(
  "preserves implicit embedding spaces independently of runtime ownership: %s",
  (command) => {
    const cfg = config(command);
    cfg.memory = { search: { provider: "local", query: { maxResults: 3 } } };
    cfg.agents = {
      entries: {
        custom: { memory: { search: { local: { modelPath: "/custom.gguf" } } } },
        blank: { memory: { search: { enabled: false, local: { modelPath: " " } } } },
      },
    };
    const result = normalizeCompatibilityConfig({ cfg });
    expect(result.config.memory?.search).toEqual({
      provider: "local",
      query: { maxResults: 3 },
      local: { modelPath: legacyModel },
    });
    expect(result.config.agents?.entries?.custom).toEqual(cfg.agents.entries?.custom);
    expect(result.config.agents?.entries?.blank?.memory?.search).toEqual({
      enabled: false,
      local: { modelPath: legacyModel },
    });
    expect(cfg.memory.search?.local?.modelPath).toBeUndefined();
    expect(normalizeCompatibilityConfig({ cfg: result.config })).toEqual({
      config: result.config,
      changes: [],
    });
  },
);

it("pins per-agent local fallback and blank overrides without replacing an explicit root", () => {
  const cfg = config(currentCommand);
  cfg.memory = { search: { provider: "openai", local: { modelPath: "/root.gguf" } } };
  cfg.agents = {
    entries: {
      inherited: { memory: { search: { provider: "local" } } },
      fallback: { memory: { search: { fallback: "local", local: { modelPath: "" } } } },
    },
  };
  const result = normalizeCompatibilityConfig({ cfg }).config;
  expect(result.memory).toEqual(cfg.memory);
  expect(result.agents?.entries?.inherited).toEqual(cfg.agents.entries?.inherited);
  expect(result.agents?.entries?.fallback?.memory?.search?.local?.modelPath).toBe(legacyModel);
});

it("does not infer a model for fresh, external or direct-model services", () => {
  const cfg = config(currentCommand);
  cfg.memory = { search: { provider: "local" } };
  for (const localService of [
    undefined,
    { command: "/custom/server", args: ["--model", "/custom.gguf"] },
  ]) {
    cfg.models!.providers!["llama-cpp"]!.localService = localService;
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
  }
  expect(normalizeCompatibilityConfig({ cfg: { memory: cfg.memory } }).changes).toEqual([]);
});
