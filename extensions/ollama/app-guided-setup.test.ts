import { text } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  capturePluginRegistration,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { createModel } from "./model.test-support.js";
import type { OllamaTagModel } from "./src/provider-models.js";

const selected = "setup-tools:latest";
const configuredModel = {
  ...createModel(selected, "Existing model", { contextWindow: 32_768 }),
  compat: { supportsTools: true },
};
const showInfo = {
  model_info: { "model.context_length": 32_768, "general.parameter_count": 4_000_000_000 },
  capabilities: ["completion", "tools"],
};

function setupAt(
  baseUrl: string,
  model = selected,
  provider: Partial<ModelProviderConfig> = {},
  signal?: AbortSignal,
) {
  const context = {
    config: { models: { providers: { ollama: { baseUrl, models: [], ...provider } } } },
    env: {},
    modelRef: `ollama/${model}`,
    signal,
  };
  const setup = expectDefined(authMethod().appGuidedSetup, "Ollama app-guided setup");
  return {
    detect: () => setup.detect(context),
    prepare: () => setup.prepare(context),
  };
}

async function withOllamaServer(
  options: {
    models?: Array<string | OllamaTagModel>;
    loaded?: string[];
    show?: Record<string, unknown>;
    showStatus?: number;
    onShow?: () => void;
  },
  run: (baseUrl: string, inspected: string[]) => Promise<void>,
) {
  const inspected: string[] = [];
  const unexpected: string[] = [];
  await withServer(
    (request, response) => {
      void (async () => {
        const body = await text(request);
        response.setHeader("content-type", "application/json");
        const send = (payload: unknown, status = 200) =>
          response.writeHead(status).end(JSON.stringify(payload));
        if (request.url === "/api/ps" || request.url === "/api/tags") {
          const models = request.url === "/api/ps" ? options.loaded : options.models;
          send({
            models: (models ?? [selected]).map((model) =>
              typeof model === "string" ? { name: model } : model,
            ),
          });
        } else if (request.url === "/api/show") {
          inspected.push((JSON.parse(body) as { model: string }).model);
          options.onShow?.();
          send(options.show ?? showInfo, options.showStatus ?? 200);
        } else {
          unexpected.push(request.url ?? "");
          response.writeHead(404).end();
        }
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    },
    (baseUrl) => run(baseUrl, inspected),
  );
  expect(unexpected).toEqual([]);
}

function authMethod(id = "ollama") {
  return expectDefined(
    capturePluginRegistration(plugin).providers.find((provider) => provider.id === id)?.auth[0],
    "Registered Ollama auth method",
  );
}

describe("Ollama app-guided setup HTTP discovery", () => {
  it("preserves remote alias output budgets during app-guided setup", async () => {
    const name = "private-alias";
    await withOllamaServer(
      {
        models: [{ name, remote_model: "upstream-model" }],
        loaded: [name],
        show: {
          ...showInfo,
          model_info: { ...showInfo.model_info, "model.context_length": 262_144 },
        },
      },
      async (baseUrl) => {
        const result = await setupAt(baseUrl, name).prepare();
        expect(result?.configPatch?.models?.providers?.ollama?.models?.[0]).toMatchObject({
          id: name,
          maxTokens: 262_144,
        });
      },
    );
  });

  it.each(["detect", "prepare"] as const)("%s skips idle models past cap", async (operation) => {
    const models = [...Array.from({ length: 200 }, (_, index) => `idle-${index}`), selected];
    await withOllamaServer({ models }, async (baseUrl, inspected) => {
      const result = await setupAt(baseUrl)[operation]();
      expect(result).toMatchObject({
        [operation === "detect" ? "modelRef" : "defaultModel"]: `ollama/${selected}`,
        ...(operation === "detect" ? { detail: `${selected} at ${baseUrl}` } : {}),
      });
      expect(inspected).toEqual([selected]);
    });
  });

  it.each([
    { name: "unmeasured context", show: { capabilities: ["completion", "tools"] } },
    { name: "no tool support", show: { ...showInfo, capabilities: ["completion"] } },
    { name: "no completion support", show: { ...showInfo, capabilities: ["tools"] } },
    { name: "failed inspection", showStatus: 503 },
  ])("rejects a loaded model with $name", async (options) => {
    await withOllamaServer(options, async (baseUrl) => {
      const setup = setupAt(baseUrl);
      await expect(setup.detect()).resolves.toBeNull();
      await expect(setup.prepare()).resolves.toBeNull();
    });
  });

  it.each(["detect", "prepare"] as const)("cancels %s inspection", async (operation) => {
    const controller = new AbortController();
    await withOllamaServer(
      { onShow: () => controller.abort(new Error("Setup cancelled")) },
      async (baseUrl, inspected) => {
        await expect(
          setupAt(baseUrl, selected, {}, controller.signal)[operation](),
        ).rejects.toThrow("Setup cancelled");
        expect(inspected).toEqual([selected]);
      },
    );
  });

  it("prepares an idle configured model while retaining the provider and its other models", async () => {
    await withOllamaServer({ loaded: [] }, async (baseUrl, inspected) => {
      const otherModel = { ...configuredModel, id: "other-model", params: { temperature: 0.5 } };
      const provider = {
        baseUrl,
        api: "ollama" as const,
        apiKey: "fixture-provider-access",
        headers: { "X-Provider": "fixture" },
        timeoutSeconds: 17,
        models: [otherModel, configuredModel],
      };
      const result = await setupAt(baseUrl, selected, provider).prepare();
      expect(result?.defaultModel).toBe(`ollama/${selected}`);
      expect(result?.configPatch?.models?.providers?.ollama).toMatchObject({
        ...provider,
        models: [otherModel, expect.objectContaining({ id: selected, contextTokens: 32_768 })],
      });
      expect(inspected).toEqual([selected]);
    });
  });

  it.each(["local", "cloud"] as const)("handles %s models absent from tags", async (kind) => {
    const model = { ...configuredModel, id: kind === "cloud" ? "setup-tools:cloud" : selected };
    await withOllamaServer({ models: [], loaded: [], show: {} }, async (baseUrl) => {
      const result = await setupAt(baseUrl, model.id, { models: [model] }).prepare();
      if (kind === "cloud") {
        expect(result?.defaultModel).toBe(`ollama/${model.id}`);
        const prepared = result?.configPatch?.models?.providers?.ollama?.models?.[0];
        expect(prepared?.contextWindow).toBe(model.contextWindow);
        expect(prepared?.contextTokens).toBeUndefined();
      } else {
        expect(result).toBeNull();
      }
    });
  });
});

const keyError = "Ollama Cloud requires a hosted API key";

function authContext(
  options: Partial<Pick<ProviderAuthContext, "env" | "opts" | "secretInputMode">>,
): ProviderAuthContext {
  return {
    config: {},
    env: {},
    opts: {},
    secretInputMode: "plaintext",
    prompter: createTestWizardPrompter({
      multiselect: async () => {
        throw new Error("Unexpected multiselect prompt");
      },
      text: async ({ initialValue }) => initialValue ?? "  ollama-local  ",
      confirm: vi.fn(async () => true),
    }),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    isRemote: false,
    openUrl: vi.fn(async () => {}),
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("Unexpected OAuth flow");
      },
    },
    ...options,
  };
}

describe("Ollama Cloud API key setup", () => {
  it.each([
    ["flag", { opts: { ollamaCloudApiKey: "ollama-local" } }],
    ["prompt", {}],
    ["env", { env: { OLLAMA_API_KEY: "ollama-local" } }],
    ["ref", { env: { OLLAMA_API_KEY: "ollama-local" }, secretInputMode: "ref" }],
  ] as const)("rejects local key from %s", async (_source, options) => {
    await expect(authMethod("ollama-cloud").run(authContext(options))).rejects.toThrow(keyError);
  });

  it("rejects a resolved local placeholder before non-interactive persistence", async () => {
    const method = authMethod("ollama-cloud");
    const toApiKeyCredential = vi.fn();
    const ctx = {
      authChoice: "ollama-cloud",
      config: {},
      baseConfig: {},
      opts: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      resolveApiKey: vi.fn(async () => ({ key: "ollama-local", source: "flag" as const })),
      toApiKeyCredential,
    };
    await expect(method.validateNonInteractive?.(ctx)).rejects.toThrow(keyError);
    await expect(method.runNonInteractive?.(ctx)).rejects.toThrow(keyError);
    expect(toApiKeyCredential).not.toHaveBeenCalled();
  });

  it("preserves a hosted key and the Cloud default model", async () => {
    const result = await authMethod("ollama-cloud").run(
      authContext({ opts: { ollamaCloudApiKey: "hosted-test-key" } }),
    );
    expect(result).toMatchObject({
      profiles: [
        {
          profileId: "ollama-cloud:default",
          credential: { provider: "ollama-cloud", type: "api_key", key: "hosted-test-key" },
        },
      ],
      defaultModel: "ollama-cloud/minimax-m2.7",
    });
  });
});
