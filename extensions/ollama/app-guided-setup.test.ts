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
const showInfo = {
  model_info: { "model.context_length": 262_144 },
  capabilities: ["completion", "tools"],
};

function setupContext(
  baseUrl: string,
  model = selected,
  provider: Partial<ModelProviderConfig> = {},
  signal?: AbortSignal,
) {
  return {
    config: { models: { providers: { ollama: { baseUrl, models: [], ...provider } } } },
    env: {},
    modelRef: `ollama/${model}`,
    signal,
  };
}

async function withOllamaServer(
  options: {
    models?: Array<string | OllamaTagModel>;
    loaded?: string[];
    show?: Record<string, unknown>;
    onShow?: () => void;
  },
  run: (baseUrl: string, inspected: string[]) => Promise<void>,
) {
  const inspected: string[] = [];
  const unexpected: string[] = [];
  await withServer(
    (request, response) => {
      void (async () => {
        try {
          const body = await text(request);
          const path = request.url ?? "";
          let payload: unknown = options.show ?? showInfo;
          if (path === "/api/ps" || path === "/api/tags") {
            const models = path === "/api/ps" ? options.loaded : options.models;
            payload = {
              models: (models ?? [selected]).map((name) =>
                typeof name === "string" ? { name } : name,
              ),
            };
          } else if (path === "/api/show") {
            inspected.push((JSON.parse(body) as { model: string }).model);
            options.onShow?.();
          } else {
            unexpected.push(path);
            response.writeHead(404).end();
            return;
          }
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(payload));
        } catch (error) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    },
    (baseUrl) => run(baseUrl, inspected),
  );
  expect(unexpected).toEqual([]);
}

const providers = capturePluginRegistration(plugin).providers;
const setup = expectDefined(
  providers.find((provider) => provider.id === "ollama")?.auth[0]?.appGuidedSetup,
  "Ollama app-guided setup",
);
const cloudAuth = expectDefined(
  providers.find((provider) => provider.id === "ollama-cloud")?.auth[0],
  "Ollama Cloud auth method",
);
const model = {
  ...createModel("private-alias", "Existing model", { contextWindow: 32_768 }),
  compat: { supportsTools: true },
};

describe("Ollama app-guided setup HTTP discovery", () => {
  it.each(["detect", "prepare"] as const)("%s skips idle models past cap", async (operation) => {
    const models = [...Array.from({ length: 200 }, (_, index) => `idle-${index}`), selected];
    await withOllamaServer({ models }, async (baseUrl, inspected) => {
      const result = await setup[operation](setupContext(baseUrl));
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
  ])("rejects a loaded model with $name", async (options) => {
    await withOllamaServer(options, async (baseUrl) => {
      const context = setupContext(baseUrl);
      await expect(setup.detect(context)).resolves.toBeNull();
      await expect(setup.prepare(context)).resolves.toBeNull();
    });
  });

  it.each(["detect", "prepare"] as const)("cancels %s inspection", async (operation) => {
    const controller = new AbortController();
    await withOllamaServer(
      { onShow: () => controller.abort(new Error("Setup cancelled")) },
      async (baseUrl) => {
        await expect(
          setup[operation](setupContext(baseUrl, selected, {}, controller.signal)),
        ).rejects.toThrow("Setup cancelled");
      },
    );
  });

  it("preserves an idle remote alias and its provider configuration", async () => {
    const otherModel = { ...model, id: "other-model", params: { temperature: 0.5 } };
    await withOllamaServer(
      {
        loaded: [],
        models: [{ name: model.id, remote_model: "upstream-model" }],
      },
      async (baseUrl) => {
        const provider = {
          baseUrl,
          api: "ollama" as const,
          apiKey: "fixture-provider-access",
          headers: { "X-Provider": "fixture" },
          timeoutSeconds: 17,
          models: [otherModel, model],
        };
        const result = await setup.prepare(setupContext(baseUrl, model.id, provider));
        expect(result?.defaultModel).toBe(`ollama/${model.id}`);
        const expected = { id: model.id, maxTokens: 262_144, contextTokens: 32_768 };
        expect(result?.configPatch?.models?.providers?.ollama).toMatchObject({
          ...provider,
          models: [otherModel, expect.objectContaining(expected)],
        });
      },
    );
  });

  it.each(["local", "cloud"] as const)("handles %s models absent from tags", async (kind) => {
    const configured = { ...model, id: kind === "cloud" ? "setup-tools:cloud" : selected };
    await withOllamaServer({ models: [], loaded: [], show: {} }, async (baseUrl) => {
      const result = await setup.prepare(
        setupContext(baseUrl, configured.id, { models: [configured] }),
      );
      if (kind === "local") {
        expect(result).toBeNull();
        return;
      }
      expect(result?.defaultModel).toBe(`ollama/${configured.id}`);
      const prepared = result?.configPatch?.models?.providers?.ollama?.models?.[0];
      expect(prepared?.contextWindow).toBe(32_768);
      expect(prepared?.contextTokens).toBeUndefined();
    });
  });
});

const keyError = "Ollama Cloud requires a hosted API key";
function unexpectedAuthFlow(): never {
  throw new Error("Unexpected auth flow");
}

function authContext(
  options: Partial<Pick<ProviderAuthContext, "env" | "opts" | "secretInputMode">>,
): ProviderAuthContext {
  return {
    config: {},
    env: {},
    secretInputMode: "plaintext",
    prompter: createTestWizardPrompter({
      multiselect: async () => unexpectedAuthFlow(),
      text: async ({ initialValue }) => initialValue ?? "  ollama-local  ",
      confirm: vi.fn(async () => true),
    }),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    isRemote: false,
    openUrl: vi.fn(async () => {}),
    oauth: { createVpsAwareHandlers: unexpectedAuthFlow },
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
    await expect(cloudAuth.run(authContext(options))).rejects.toThrow(keyError);
  });

  it("rejects a resolved local placeholder before non-interactive persistence", async () => {
    const ctx = {
      ...authContext({}),
      authChoice: "ollama-cloud",
      baseConfig: {},
      opts: {},
      resolveApiKey: vi.fn(async () => ({ key: "ollama-local", source: "flag" as const })),
      toApiKeyCredential: vi.fn(),
    };
    await expect(cloudAuth.validateNonInteractive?.(ctx)).rejects.toThrow(keyError);
    await expect(cloudAuth.runNonInteractive?.(ctx)).rejects.toThrow(keyError);
    expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
  });

  it("preserves a hosted key and the Cloud default model", async () => {
    const result = await cloudAuth.run(
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
