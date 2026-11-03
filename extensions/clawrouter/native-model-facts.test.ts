import fs from "node:fs";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple, type Context, type Model } from "openclaw/plugin-sdk/llm";
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const providerAuthRuntimeMocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "fixture-key" })),
}));

// mock-isolation: Never read real auth profile stores; these fixtures need only a fixed key.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => providerAuthRuntimeMocks);

import plugin from "./index.js";
import {
  buildClawRouterProviderConfig,
  normalizeClawRouterResolvedModel,
} from "./provider-catalog.js";

const RESPONSES: [string[]] = [["llm.responses"]];
const MESSAGES: [string[], Array<[string, string]>] = [
  ["llm.messages"],
  [["/v1/messages", "anthropic.messages"]],
];

function catalogProvider(
  id: string,
  upstream: string,
  capabilities: string[],
  routes: Array<[string, string]> = [],
  model: Record<string, unknown> = {},
) {
  return {
    id,
    displayName: id,
    openaiCompatible: id === "openai" || id === "deepseek",
    nativeBaseUrl: `/v1/native/${id}`,
    routes: routes.map(([path, requestFormat]) => ({ path, requestFormat, methods: ["POST"] })),
    models: [{ id: `${id}/${upstream}`, upstream, capabilities, ...model }],
  };
}

async function buildCatalog(providers: unknown[]) {
  const fetchGuard: LiveModelCatalogFetchGuard = async () => ({
    response: Response.json({ providers }),
    finalUrl: "https://clawrouter.example/v1/catalog",
    release: async () => undefined,
  });
  const guardedFetch = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(fetchGuard);
  onTestFinished(() => guardedFetch.mockRestore());
  return await buildClawRouterProviderConfig({
    apiKey: "fixture-key",
    baseUrl: "https://clawrouter.example",
  });
}

type NativeManifestRow = Record<string, unknown> & {
  id: string;
  compat?: { codeMode?: string; supportsTemperature?: boolean };
  mediaInput?: unknown;
};

// The shipped first-party catalogs are the parity oracle; never copy their values here.
function readNativeManifest(pluginId: "openai" | "anthropic") {
  const manifest = JSON.parse(
    fs.readFileSync(new URL(`../${pluginId}/openclaw.plugin.json`, import.meta.url), "utf8"),
  ) as {
    modelCatalog: {
      providers: Record<string, { api: string; baseUrl: string; models: NativeManifestRow[] }>;
    };
  };
  const provider = manifest.modelCatalog.providers[pluginId];
  if (!provider) {
    throw new Error(`missing native ${pluginId} catalog`);
  }
  return provider;
}

function nativeRow(pluginId: "openai" | "anthropic", modelId: string): NativeManifestRow {
  const row = readNativeManifest(pluginId).models.find(({ id }) => id === modelId);
  if (!row) {
    throw new Error(`missing native ${pluginId}/${modelId}`);
  }
  return row;
}

function modelFacts(model: { compat?: unknown; mediaInput?: unknown } | undefined) {
  const compat = model?.compat as NativeManifestRow["compat"];
  return {
    codeMode: compat?.codeMode,
    supportsTemperature: compat?.supportsTemperature,
    mediaInput: model?.mediaInput,
  };
}

// Sends one real transport request and returns its JSON body.
async function captureRequestBody(
  dispatch: () => ReturnType<StreamFn>,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockClear()
    .mockImplementation(async (input, init) => {
      body = (await new Request(input, init).json()) as Record<string, unknown>;
      // The request body is the observable; end the turn without a provider stream.
      const error = { type: "invalid_request_error", message: "fixture" };
      return Response.json({ error }, { status: 400 });
    });
  onTestFinished(() => fetchMock.mockRestore());
  await (await dispatch()).result();
  expect(fetchMock).toHaveBeenCalledOnce();
  if (!body) {
    throw new Error("transport did not send a request body");
  }
  return body;
}

describe("ClawRouter native model facts", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("gives routed OpenAI and Claude rows the native facts for the same upstream model", async () => {
    const provider = await buildCatalog([
      catalogProvider("openai", "gpt-6.1-sol", ...RESPONSES, [], {
        supportedReasoningEfforts: ["low", "high"],
      }),
      catalogProvider("openai", "gpt-6-luna", ...RESPONSES),
      catalogProvider("openai", "gpt-5.5", ...RESPONSES),
      catalogProvider("anthropic", "claude-opus-5-5", ...MESSAGES),
      catalogProvider("anthropic", "claude-haiku-4-5", ...MESSAGES),
    ]);
    const routed = Object.fromEntries(
      provider.models.map((model) => [model.id, modelFacts(model)]),
    );

    expect(routed).toEqual({
      "openai/gpt-6.1-sol": modelFacts(nativeRow("openai", "gpt-6.1-sol")),
      "openai/gpt-6-luna": modelFacts(nativeRow("openai", "gpt-6-luna")),
      "openai/gpt-5.5": modelFacts(nativeRow("openai", "gpt-5.5")),
      "anthropic/claude-opus-5-5": modelFacts(nativeRow("anthropic", "claude-opus-5-5")),
      "anthropic/claude-haiku-4-5": modelFacts(nativeRow("anthropic", "claude-haiku-4-5")),
    });
    // Pin the oracle so a manifest edit cannot make both sides vacuously empty.
    expect(routed["openai/gpt-6.1-sol"]).toMatchObject({
      codeMode: "preferred",
      supportsTemperature: false,
    });
    expect(routed["anthropic/claude-opus-5-5"]?.mediaInput).toMatchObject({
      image: { maxSidePx: 2576 },
    });
    expect(routed["anthropic/claude-haiku-4-5"]).toMatchObject({
      codeMode: "capable",
      mediaInput: { image: { maxSidePx: 1568 } },
    });
    // The service catalog keeps ownership of the route's reasoning contract.
    expect(provider.models.find(({ id }) => id === "openai/gpt-6.1-sol")?.compat).toEqual({
      codeMode: "preferred",
      supportsTemperature: false,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "high"],
    });
  });

  it("inherits nothing for unknown ids, other wire APIs or unqualified upstream catalogs", async () => {
    const provider = await buildCatalog([
      catalogProvider("openai", "gpt-6-unknown", ...RESPONSES),
      catalogProvider("openai", "GPT-6.1-SOL", ...RESPONSES),
      // Native GPT-6 Astra is a Responses row; Chat Completions facts are not the same contract.
      catalogProvider("openai", "gpt-6-astra", ["llm.chat"]),
      catalogProvider("anthropic", "claude-opus-6", ...MESSAGES),
      // DeepSeek's native catalog declares Code Mode, but this route is not parity-qualified.
      catalogProvider("deepseek", "deepseek-v4-flash", ["llm.chat"]),
    ]);

    expect(provider.models.map(({ id }) => id).toSorted()).toEqual([
      "anthropic/claude-opus-6",
      "deepseek/deepseek-v4-flash",
      "openai/GPT-6.1-SOL",
      "openai/gpt-6-astra",
      "openai/gpt-6-unknown",
    ]);
    for (const model of provider.models) {
      expect(model.compat, model.id).toBeUndefined();
      expect(model.mediaInput, model.id).toBeUndefined();
    }
  });

  it("names routed rows with the family their bundled catalog declares for the same model", async () => {
    const google: [string[], Array<[string, string]>] = [
      ["llm.stream"],
      [["/v1beta/models/${model}:streamGenerateContent", "google.generate_content"]],
    ];
    const provider = await buildCatalog([
      catalogProvider("anthropic", "claude-opus-5-5", ...MESSAGES),
      catalogProvider("openai", "gpt-6.1-sol", ...RESPONSES),
      catalogProvider("google-gemini", "gemini-3.5-flash", ...google),
      // Not in the bundled catalog: the developer is not inferred from the id or provider.
      catalogProvider("anthropic", "claude-opus-6", ...MESSAGES),
      // Another wire API is another route contract, so it inherits no identity facts.
      catalogProvider("openai", "gpt-6-astra", ["llm.chat"]),
      catalogProvider("acme", "claude-opus-5-5", ...MESSAGES),
    ]);
    const families = Object.fromEntries(provider.models.map(({ id, family }) => [id, family]));
    const declared = (pluginId: "openai" | "anthropic" | "google") =>
      (
        JSON.parse(
          fs.readFileSync(new URL(`../${pluginId}/openclaw.plugin.json`, import.meta.url), "utf8"),
        ) as { modelCatalog: { providers: Record<string, { family?: string }> } }
      ).modelCatalog.providers[pluginId]?.family;

    expect(families).toEqual({
      "anthropic/claude-opus-5-5": declared("anthropic"),
      "openai/gpt-6.1-sol": declared("openai"),
      "google-gemini/gemini-3.5-flash": declared("google"),
      "anthropic/claude-opus-6": undefined,
      "openai/gpt-6-astra": undefined,
      "acme/claude-opus-5-5": undefined,
    });
    // Pin the oracle so a manifest edit cannot make both sides vacuously empty.
    expect([declared("anthropic"), declared("openai"), declared("google")]).toEqual([
      "anthropic",
      "openai",
      "google",
    ]);
  });

  it("resolves routed Claude models with the native image limits used for compression", async () => {
    // Runtime model resolution prefers this hook's model; image compression reads its mediaInput.
    const registered = await registerSingleProviderPlugin(plugin);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        providers: [
          catalogProvider("anthropic", "claude-opus-5-5", ...MESSAGES),
          catalogProvider("anthropic", "claude-haiku-4-5", ...MESSAGES),
        ],
      }),
    );
    onTestFinished(() => fetchMock.mockRestore());
    const resolve = async (modelId: string) =>
      (await registered.prepareDynamicModel?.({
        config: { models: {} },
        provider: "clawrouter",
        modelId,
        modelRegistry: { find: () => null },
      } as never)) || undefined;

    for (const upstream of ["claude-opus-5-5", "claude-haiku-4-5"]) {
      expect(modelFacts(await resolve(`anthropic/${upstream}`))).toEqual(
        modelFacts(nativeRow("anthropic", upstream)),
      );
    }
    expect((await resolve("anthropic/claude-opus-5-5"))?.mediaInput).toMatchObject({
      image: { maxSidePx: 2576 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const)(
    "%s drops temperature for routed GPT-6 exactly like the native row",
    async (hook) => {
      const registered = await registerSingleProviderPlugin(plugin);
      const catalog = await buildCatalog([
        catalogProvider("openai", "gpt-6.1-sol", ...RESPONSES),
        catalogProvider("openai", "gpt-6-unknown", ...RESPONSES),
      ]);
      const routedModel = (id: string) => {
        const row = catalog.models.find((model) => model.id === id);
        const model = normalizeClawRouterResolvedModel({
          ...row,
          provider: "clawrouter",
        } as ProviderRuntimeModel);
        if (!model) {
          throw new Error(`missing routed ${id}`);
        }
        return model as Model;
      };
      const native = readNativeManifest("openai");
      const nativeSol = nativeRow("openai", "gpt-6.1-sol");
      const nativeModel = {
        ...nativeSol,
        provider: "openai",
        api: native.api,
        baseUrl: native.baseUrl,
      } as unknown as Model;
      // Utility callers such as session summaries pass temperature explicitly.
      const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
      const options = { apiKey: "fixture-key", temperature: 0.2, maxTokens: 64 };
      const routedBody = (id: string) =>
        captureRequestBody(() => {
          const wrapped = registered[hook]?.({
            provider: "clawrouter",
            modelId: id,
            streamFn: streamSimple,
          });
          if (!wrapped) {
            throw new Error(`missing ClawRouter ${hook}`);
          }
          return wrapped(routedModel(id), context, options);
        });

      const nativeBody = await captureRequestBody(() =>
        streamSimple(nativeModel, context, options),
      );
      const routed = await routedBody("openai/gpt-6.1-sol");
      expect(nativeBody).toMatchObject({ model: "gpt-6.1-sol" });
      expect(nativeBody).not.toHaveProperty("temperature");
      expect(routed).toMatchObject({ model: "openai/gpt-6.1-sol" });
      expect(routed).not.toHaveProperty("temperature");

      // Unknown models fail closed to the route's ordinary request shape.
      expect(await routedBody("openai/gpt-6-unknown")).toMatchObject({ temperature: 0.2 });
    },
  );

  it.each(["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const)(
    "%s ends routed Claude thinking requests with a user turn",
    async (hook) => {
      const registered = await registerSingleProviderPlugin(plugin);
      const catalog = await buildCatalog([
        catalogProvider("anthropic", "claude-opus-4-8", ...MESSAGES),
      ]);
      const model = normalizeClawRouterResolvedModel({
        ...catalog.models[0],
        provider: "clawrouter",
      } as ProviderRuntimeModel) as Model;
      const wrapped = registered[hook]?.({
        provider: "clawrouter",
        modelId: model.id,
        streamFn: streamSimple,
      });
      if (!wrapped) {
        throw new Error(`missing ClawRouter ${hook}`);
      }
      const context: Context = {
        messages: [
          { role: "user", content: "Name a color.", timestamp: 0 },
          {
            role: "assistant",
            content: [{ type: "text", text: "The color is" }],
            api: "anthropic-messages",
            provider: "clawrouter",
            model: model.id,
            usage: createZeroUsageFixture(),
            stopReason: "stop",
            timestamp: 1,
          },
        ],
      };
      const send = (reasoning?: "high") =>
        captureRequestBody(() =>
          wrapped(model, context, {
            apiKey: "fixture-key",
            maxTokens: 2048,
            ...(reasoning ? { reasoning } : {}),
          }),
        );

      const thinking = await send("high");
      expect(thinking).toMatchObject({ model: "claude-opus-4-8" });
      expect((thinking.thinking as { type?: unknown } | undefined)?.type).toMatch(
        /^(?:adaptive|enabled)$/u,
      );
      expect((thinking.messages as Array<{ role: string }>).map(({ role }) => role)).toEqual([
        "user",
      ]);

      // Without thinking, the assistant prefill remains a valid continuation.
      const plain = await send();
      expect(plain.thinking).toEqual({ type: "disabled" });
      expect((plain.messages as Array<{ role: string }>).map(({ role }) => role)).toEqual([
        "user",
        "assistant",
      ]);
    },
  );
});
