import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  installModelsConfigTestHooks,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";

vi.mock("./auth-profiles/external-cli-sync.js", () => ({
  syncExternalCliCredentials: () => false,
}));

installModelsConfigTestHooks();

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("./auth-profiles/store.js").clearRuntimeAuthProfileStoreSnapshots;
let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let resetModelsJsonReadyCacheForTest: typeof import("./models-config.js").resetModelsJsonReadyCacheForTest;
let readGeneratedModelsJson: typeof import("./models-config.test-utils.js").readGeneratedModelsJson;

beforeEach(async () => {
  vi.resetModules();
  ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
  ({ clearRuntimeAuthProfileStoreSnapshots } = await import("./auth-profiles/store.js"));
  ({ ensureOpenClawModelsJson, resetModelsJsonReadyCacheForTest } =
    await import("./models-config.js"));
  ({ readGeneratedModelsJson } = await import("./models-config.test-utils.js"));
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  resetModelsJsonReadyCacheForTest();
});

type ModelEntry = {
  id: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

type ModelsJson = {
  providers: Record<string, { models?: ModelEntry[] }>;
};

const MINIMAX_ENV_KEY = "MINIMAX_API_KEY";
const MINIMAX_MODEL_ID = "MiniMax-M2.7";
const MINIMAX_TEST_KEY = "sk-minimax-test";

const baseMinimaxProvider = {
  baseUrl: "https://api.minimax.io/anthropic",
  api: "anthropic-messages",
} as const;

async function withMinimaxApiKey(run: () => Promise<void>) {
  const prev = process.env[MINIMAX_ENV_KEY];
  process.env[MINIMAX_ENV_KEY] = MINIMAX_TEST_KEY;
  try {
    await run();
  } finally {
    if (prev === undefined) {
      delete process.env[MINIMAX_ENV_KEY];
    } else {
      process.env[MINIMAX_ENV_KEY] = prev;
    }
  }
}

async function generateAndReadMinimaxModel(cfg: OpenClawConfig): Promise<ModelEntry | undefined> {
  await ensureOpenClawModelsJson(cfg);
  const parsed = await readGeneratedModelsJson<ModelsJson>();
  return parsed.providers.minimax?.models?.find((model) => model.id === MINIMAX_MODEL_ID);
}

describe("models-config: explicit reasoning override", () => {
  it("preserves user reasoning:false when built-in catalog has reasoning:true (MiniMax-M2.7)", async () => {
    // MiniMax-M2.7 has reasoning:true in the built-in catalog.
    // User explicitly sets reasoning:false to avoid message-ordering conflicts.
    await withTempHome(async () => {
      await withMinimaxApiKey(async () => {
        const cfg: OpenClawConfig = {
          models: {
            providers: {
              minimax: {
                ...baseMinimaxProvider,
                models: [
                  {
                    id: MINIMAX_MODEL_ID,
                    name: "MiniMax M2.7",
                    reasoning: false, // explicit override: user wants to disable reasoning
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 1000000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
        };

        const m25 = await generateAndReadMinimaxModel(cfg);
        expect(m25).toBeDefined();
        // Must honour the explicit false — built-in true must NOT win.
        expect(m25?.reasoning).toBe(false);
      });
    });
  });

  it("falls back to built-in reasoning:true when user omits the field (MiniMax-M2.7)", async () => {
    // When the user does not set reasoning at all, the built-in catalog value
    // (true for MiniMax-M2.7) should be used so the model works out of the box.
    await withTempHome(async () => {
      await withMinimaxApiKey(async () => {
        // Omit 'reasoning' to simulate a user config that doesn't set it.
        const modelWithoutReasoning = {
          id: MINIMAX_MODEL_ID,
          name: "MiniMax M2.7",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 8192,
        };
        const cfg: OpenClawConfig = {
          models: {
            providers: {
              minimax: {
                ...baseMinimaxProvider,
                // @ts-expect-error Intentional: emulate user config omitting reasoning.
                models: [modelWithoutReasoning],
              },
            },
          },
        };

        const m25 = await generateAndReadMinimaxModel(cfg);
        expect(m25).toBeDefined();
        // Built-in catalog has reasoning:true — should be applied as default.
        expect(m25?.reasoning).toBe(true);
      });
    });
  });
});
