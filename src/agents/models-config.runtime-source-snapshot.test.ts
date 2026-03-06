import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  loadConfig,
  setRuntimeConfigSnapshot,
} from "../config/config.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import {
  installModelsConfigTestHooks,
  withModelsTempHome as withTempHome,
} from "./models-config.e2e-harness.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";

installModelsConfigTestHooks();

describe("models-config runtime source snapshot", () => {
  it("uses runtime source snapshot markers when passed the active runtime config", async () => {
    await withTempHome(async () => {
      const sourceConfig: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              api: "openai-completions" as const,
              models: [],
            },
          },
        },
      };
      const runtimeConfig: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: "sk-runtime-resolved",
              api: "openai-completions" as const,
              models: [],
            },
          },
        },
      };

      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
        await ensureOpenClawModelsJson(loadConfig());

        const parsed = await readGeneratedModelsJson<{
          providers: Record<string, { apiKey?: string }>;
        }>();
        expect(parsed.providers.openai?.apiKey).toBe("OPENAI_API_KEY");
      } finally {
        clearRuntimeConfigSnapshot();
        clearConfigCache();
      }
    });
  });

  it("uses non-env marker from runtime source snapshot for file refs", async () => {
    await withTempHome(async () => {
      const sourceConfig: OpenClawConfig = {
        models: {
          providers: {
            moonshot: {
              baseUrl: "https://api.moonshot.ai/v1",
              apiKey: { source: "file", provider: "vault", id: "/moonshot/apiKey" },
              api: "openai-completions" as const,
              models: [],
            },
          },
        },
      };
      const runtimeConfig: OpenClawConfig = {
        models: {
          providers: {
            moonshot: {
              baseUrl: "https://api.moonshot.ai/v1",
              apiKey: "sk-runtime-moonshot",
              api: "openai-completions" as const,
              models: [],
            },
          },
        },
      };

      try {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
        await ensureOpenClawModelsJson(loadConfig());

        const parsed = await readGeneratedModelsJson<{
          providers: Record<string, { apiKey?: string }>;
        }>();
        expect(parsed.providers.moonshot?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
      } finally {
        clearRuntimeConfigSnapshot();
        clearConfigCache();
      }
    });
  });
});
