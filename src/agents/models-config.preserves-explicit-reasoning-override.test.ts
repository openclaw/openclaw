import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  installModelsConfigTestHooks,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";

installModelsConfigTestHooks();

type ModelEntry = {
  id: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

type ModelsJson = {
  providers: Record<string, { models?: ModelEntry[] }>;
};

describe("models-config: explicit reasoning override", () => {
  it("preserves user reasoning:false when built-in catalog has reasoning:true (MiniMax-M2.5)", async () => {
    // MiniMax-M2.5 has reasoning:true in the built-in catalog.
    // User explicitly sets reasoning:false to avoid message-ordering conflicts.
    await withTempHome(async () => {
      const prevKey = process.env.MINIMAX_API_KEY;
      process.env.MINIMAX_API_KEY = "sk-minimax-test";
      try {
        const cfg: OpenClawConfig = {
          models: {
            providers: {
              minimax: {
                baseUrl: "https://api.minimax.io/anthropic",
                api: "anthropic-messages",
                models: [
                  {
                    id: "MiniMax-M2.5",
                    name: "MiniMax M2.5",
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

        await ensureOpenClawModelsJson(cfg);

        const raw = await fs.readFile(path.join(resolveOpenClawAgentDir(), "models.json"), "utf8");
        const parsed = JSON.parse(raw) as ModelsJson;
        const m25 = parsed.providers.minimax?.models?.find((m) => m.id === "MiniMax-M2.5");
        expect(m25).toBeDefined();
        // Must honour the explicit false — built-in true must NOT win.
        expect(m25?.reasoning).toBe(false);
      } finally {
        if (prevKey === undefined) {
          delete process.env.MINIMAX_API_KEY;
        } else {
          process.env.MINIMAX_API_KEY = prevKey;
        }
      }
    });
  });

  it("falls back to built-in reasoning:true when user omits the field (MiniMax-M2.5)", async () => {
    // When the user does not set reasoning at all, the built-in catalog value
    // (true for MiniMax-M2.5) should be used so the model works out of the box.
    await withTempHome(async () => {
      const prevKey = process.env.MINIMAX_API_KEY;
      process.env.MINIMAX_API_KEY = "sk-minimax-test";
      try {
        // Omit 'reasoning' to simulate a user config that doesn't set it.
        const modelWithoutReasoning = {
          id: "MiniMax-M2.5",
          name: "MiniMax M2.5",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 8192,
        };
        const cfg: OpenClawConfig = {
          models: {
            providers: {
              minimax: {
                baseUrl: "https://api.minimax.io/anthropic",
                api: "anthropic-messages",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                models: [modelWithoutReasoning as any],
              },
            },
          },
        };

        await ensureOpenClawModelsJson(cfg);

        const raw = await fs.readFile(path.join(resolveOpenClawAgentDir(), "models.json"), "utf8");
        const parsed = JSON.parse(raw) as ModelsJson;
        const m25 = parsed.providers.minimax?.models?.find((m) => m.id === "MiniMax-M2.5");
        expect(m25).toBeDefined();
        // Built-in catalog has reasoning:true — should be applied as default.
        expect(m25?.reasoning).toBe(true);
      } finally {
        if (prevKey === undefined) {
          delete process.env.MINIMAX_API_KEY;
        } else {
          process.env.MINIMAX_API_KEY = prevKey;
        }
      }
    });
  });
});
