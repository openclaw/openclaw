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

function setupContext(baseUrl: string, provider: Partial<ModelProviderConfig> = {}) {
  return {
    config: { models: { providers: { ollama: { baseUrl, models: [], ...provider } } } },
    env: {},
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

function guidedSetup() {
  return expectDefined(authMethod().appGuidedSetup, "Ollama app-guided setup");
}

function prepare(baseUrl: string, model = selected, provider: Partial<ModelProviderConfig> = {}) {
  return guidedSetup().prepare({ ...setupContext(baseUrl, provider), modelRef: `ollama/${model}` });
}

function runSetup(operation: "detect" | "prepare", baseUrl: string, signal?: AbortSignal) {
  return guidedSetup()[operation]({
    ...setupContext(baseUrl),
    modelRef: `ollama/${selected}`,
    signal,
  });
}

describe("Ollama app-guided setup HTTP discovery", () => {
  it.each([
    { tag: { remote_host: "https://ollama.com" }, expected: 262_144 },
    { tag: { remote_model: "upstream-model" }, expected: 262_144 },
    { tag: {}, expected: 8192 },
  ])("preserves alias output budgets for $tag", async ({ tag, expected }) => {
    const name = "private-alias";
    await withOllamaServer(
      {
        models: [{ name, ...tag }],
        loaded: [name],
        show: {
          ...showInfo,
          model_info: { ...showInfo.model_info, "model.context_length": 262_144 },
        },
      },
      async (baseUrl) => {
        const prepared = await prepare(baseUrl, name);
        const provider = prepared?.configPatch?.models?.providers?.ollama;
        expect(prepared).toMatchObject({ profiles: [], defaultModel: `ollama/${name}` });
        expect(prepared?.configPatch?.models?.mode).toBe("merge");
        expect(provider).toMatchObject({
          baseUrl,
          api: "ollama",
          apiKey: "ollama-local",
        });
        expect(provider?.models?.[0]).not.toHaveProperty("parameterCount");
        expect(provider?.models?.[0]).toMatchObject({
          id: name,
          maxTokens: expected,
        });
      },
    );
  });

  it.each(["detect", "prepare"] as const)("%s skips idle models past cap", async (operation) => {
    const models = [...Array.from({ length: 200 }, (_, index) => `idle-${index}`), selected];
    await withOllamaServer({ models }, async (baseUrl, inspected) => {
      const result = await runSetup(operation, baseUrl);
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
      await expect(guidedSetup().detect(setupContext(baseUrl))).resolves.toBeNull();
      await expect(prepare(baseUrl)).resolves.toBeNull();
    });
  });

  it.each(["detect", "prepare"] as const)("cancels %s inspection", async (operation) => {
    const controller = new AbortController();
    await withOllamaServer(
      { onShow: () => controller.abort(new Error("Setup cancelled")) },
      async (baseUrl, inspected) => {
        await expect(runSetup(operation, baseUrl, controller.signal)).rejects.toThrow(
          "Setup cancelled",
        );
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
      const result = await prepare(baseUrl, selected, provider);
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
      const result = await prepare(baseUrl, model.id, { models: [model] });
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

const cloudAuthMethod = () => authMethod("ollama-cloud");

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
  it.each(["flag", "prompt", "env", "ref"] as const)(
    "rejects local key from %s",
    async (source) => {
      await expect(
        cloudAuthMethod().run(
          authContext({
            env: source === "env" || source === "ref" ? { OLLAMA_API_KEY: "ollama-local" } : {},
            opts: source === "flag" ? { ollamaCloudApiKey: "ollama-local" } : {},
            secretInputMode: source === "ref" ? "ref" : "plaintext",
          }),
        ),
      ).rejects.toThrow(keyError);
    },
  );

  it("rejects a resolved local placeholder before non-interactive persistence", async () => {
    const method = cloudAuthMethod();
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
    const result = await cloudAuthMethod().run(
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
