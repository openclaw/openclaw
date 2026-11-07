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
