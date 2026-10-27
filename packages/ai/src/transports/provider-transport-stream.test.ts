import type { Api, Model } from "@openclaw/llm-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import {
  buildTransportAwareSimpleStreamFn,
  createBoundaryAwareStreamFnForModel,
  createTransportAwareStreamFnForModel,
  prepareTransportAwareSimpleModel,
  resolveTransportAwareSimpleApi,
} from "./provider-transport-stream.js";

const managedTransportModels = new WeakSet<object>();
const initialHost = getAiTransportHost();

beforeAll(() => {
  configureAiTransportHost({
    requiresManagedTransport: (model) => managedTransportModels.has(model),
    inheritManagedTransport: (source, target) => {
      if (managedTransportModels.has(source)) {
        managedTransportModels.add(target);
      }
      return target;
    },
  });
});

afterAll(() => {
  configureAiTransportHost(initialHost);
});

function buildModel<TApi extends Api>(api: TApi, id: string, provider: string) {
  const model = makeProviderModel(api, provider, id);
  managedTransportModels.add(model);
  return model;
}

describe("provider transport stream contracts", () => {
  it("covers the supported transport api alias matrix", () => {
    const cases: [Model, string][] = [
      [buildModel("openai-responses", "gpt-5.4", "openai"), "openclaw-openai-responses-transport"],
      [
        buildModel("openai-chatgpt-responses", "codex-mini-latest", "openai"),
        "openclaw-openai-chatgpt-responses-transport",
      ],
      [buildModel("openai-completions", "grok-4", "xai"), "openclaw-openai-completions-transport"],
      [
        buildModel("azure-openai-responses", "gpt-5.4", "azure-openai-responses"),
        "openclaw-azure-openai-responses-transport",
      ],
      [
        buildModel("anthropic-messages", "claude-sonnet-4.6", "anthropic"),
        "openclaw-anthropic-messages-transport",
      ],
      [
        buildModel("google-generative-ai", "gemini-3.1-pro-preview", "google"),
        "openclaw-google-generative-ai-transport",
      ],
    ];

    for (const [model, alias] of cases) {
      expect(resolveTransportAwareSimpleApi(model.api)).toBe(alias);
      if (model.api === "google-generative-ai") {
        continue;
      }
      expect(createBoundaryAwareStreamFnForModel(model)).toBeTypeOf("function");
      expect(createTransportAwareStreamFnForModel(model)).toBeTypeOf("function");
      expect(buildTransportAwareSimpleStreamFn(model)).toBeTypeOf("function");
      const { provider, id } = model;
      const preparedModel = prepareTransportAwareSimpleModel(model);
      expect(preparedModel).toMatchObject({ api: alias, provider, id });
      expect(managedTransportModels.has(preparedModel)).toBe(true);
    }
  });

  it("fails closed when a required Google transport is unavailable", () => {
    const model = buildModel("google-generative-ai", "gemini-3.1-pro-preview", "google");

    expect(() => createTransportAwareStreamFnForModel(model)).toThrow(
      'Managed transport stream is unavailable for api "google-generative-ai"',
    );
  });

  it("fails closed when unsupported apis carry transport overrides", () => {
    const model = buildModel("ollama", "qwen3:32b", "ollama");

    expect(resolveTransportAwareSimpleApi(model.api)).toBeUndefined();
    expect(createBoundaryAwareStreamFnForModel(model)).toBeUndefined();
    for (const prepare of [
      createTransportAwareStreamFnForModel,
      buildTransportAwareSimpleStreamFn,
      prepareTransportAwareSimpleModel,
    ]) {
      expect(() => prepare(model)).toThrow(
        'Model-provider request.proxy/request.tls/localService is not yet supported for api "ollama"',
      );
    }
  });
});
