import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../src/config/config.js";
import { buildPluginApi } from "../../src/plugins/api-builder.js";
import type { PluginRuntime } from "../../src/plugins/runtime/types.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import amazonBedrockPlugin from "./index.js";

// Minimal shapes for the deeply generic pi-ai/plugin types used in tests.
// Tests return the options object (not a real stream) to assert injected fields.
type TestStreamModel = { api: string; provider: string; id: string };
type TestStreamContext = { messages: unknown[] };
type TestStreamOptions = Record<string, unknown>;
type TestStreamFn = (model: TestStreamModel, context: TestStreamContext, options: TestStreamOptions) => TestStreamOptions;
type TestConfig = {
  models?: {
    bedrockDiscovery?: { region?: string };
    providers?: Record<string, { baseUrl?: string; models?: Array<{ id: string; name: string }> }>;
  };
};

const provider = registerSingleProviderPlugin(amazonBedrockPlugin);
const passThroughFn: TestStreamFn = (_model, _context, options) => options;

function wrapStream(modelId: string, config?: TestConfig) {
  return provider.wrapStreamFn?.({
    provider: "amazon-bedrock",
    modelId,
    config,
    streamFn: passThroughFn,
  } as never) as TestStreamFn | null | undefined;
}

function invokeWrapped(wrapped: TestStreamFn | null | undefined, modelId: string, api = "bedrock-converse-stream") {
  return wrapped?.({ api, provider: "amazon-bedrock", id: modelId }, { messages: [] }, {});
}

type RegisteredProviderPlugin = ReturnType<typeof registerSingleProviderPlugin>;

/** Register the amazon-bedrock plugin with an optional pluginConfig override. */
function registerWithConfig(pluginConfig?: Record<string, unknown>): RegisteredProviderPlugin {
  const providers: RegisteredProviderPlugin[] = [];
  const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };
  const api = buildPluginApi({
    id: "amazon-bedrock",
    name: "Amazon Bedrock Provider",
    source: "test",
    registrationMode: "full",
    config: {} as OpenClawConfig,
    pluginConfig,
    runtime: {} as PluginRuntime,
    logger: noopLogger,
    resolvePath: (input) => input,
    handlers: {
      registerProvider(provider: RegisteredProviderPlugin) {
        providers.push(provider);
      },
    },
  });
  amazonBedrockPlugin.register(api);
  const provider = providers[0];
  if (!provider) throw new Error("provider registration missing");
  return provider;
}

/** Spy streamFn that returns the options it receives. */
const spyStreamFn = (_model: unknown, _context: unknown, options: Record<string, unknown>) =>
  options;

const ANTHROPIC_MODEL = "us.anthropic.claude-sonnet-4-6-v1";
const NON_ANTHROPIC_MODEL = "amazon.nova-micro-v1:0";

const MODEL_DESCRIPTOR = {
  api: "openai-completions",
  provider: "amazon-bedrock",
  id: NON_ANTHROPIC_MODEL,
} as never;

const ANTHROPIC_MODEL_DESCRIPTOR = {
  api: "openai-completions",
  provider: "amazon-bedrock",
  id: ANTHROPIC_MODEL,
} as never;

/**
 * Call wrapStreamFn and then invoke the returned stream function, capturing
 * the payload via the onPayload hook that streamWithPayloadPatch installs.
 */
function callWrappedStream(
  provider: RegisteredProviderPlugin,
  modelId: string,
  modelDescriptor: never,
): Record<string, unknown> {
  const wrapped = provider.wrapStreamFn?.({
    provider: "amazon-bedrock",
    modelId,
    streamFn: spyStreamFn,
  } as never);

  // The wrapped stream returns the options object (from spyStreamFn).
  // For guardrail-wrapped streams, streamWithPayloadPatch intercepts onPayload,
  // so we need to invoke onPayload on the returned options to trigger the patch.
  const result = wrapped?.(modelDescriptor, { messages: [] } as never, {}) as unknown as Record<
    string,
    unknown
  >;

  // If onPayload was installed by streamWithPayloadPatch, call it to apply the patch.
  if (typeof result?.onPayload === "function") {
    const payload: Record<string, unknown> = {};
    (result.onPayload as (p: Record<string, unknown>) => void)(payload);
    return { ...result, _capturedPayload: payload };
  }

  return result;
}

describe("amazon-bedrock provider plugin", () => {
  it("marks Claude 4.6 Bedrock models as adaptive by default", () => {
    expect(
      provider.resolveDefaultThinkingLevel?.({
        provider: "amazon-bedrock",
        modelId: "us.anthropic.claude-opus-4-6-v1",
      }),
    ).toBe("adaptive");
    expect(
      provider.resolveDefaultThinkingLevel?.({
        provider: "amazon-bedrock",
        modelId: "amazon.nova-micro-v1:0",
      }),
    ).toBeUndefined();
  });

  describe("prompt caching", () => {
    it("enables prompt caching for inference profile ARNs with 'claude' in profile ID", () => {
      const arn =
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile";
      const result = wrapStream(arn, {
        models: {
          providers: {
            "amazon-bedrock": {
              models: [{ id: arn, name: "Claude Sonnet 4.6 via Inference Profile" }],
            },
          },
        },
      });
      expect(result).toBe(passThroughFn);
    });

    it("enables prompt caching for inference profile when config uses provider alias", () => {
      const arn =
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile";
      const result = wrapStream(arn, {
        models: {
          providers: {
            bedrock: {
              models: [{ id: arn, name: "Claude Sonnet 4.6 via Inference Profile" }],
            },
          },
        },
      });
      expect(result).toBe(passThroughFn);
    });

    it("disables prompt caching for inference profile ARNs without 'claude' in profile ID", () => {
      const arn =
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/llama-profile";
      const wrapped = wrapStream(arn, {
        models: {
          providers: {
            "amazon-bedrock": {
              models: [{ id: arn, name: "Llama 2 via Inference Profile" }],
            },
          },
        },
      });
      expect(invokeWrapped(wrapped, arn, "openai-completions")).toMatchObject({
        cacheRetention: "none",
      });
    });

    it("disables prompt caching for inference profile ARNs with no config entry", () => {
      const arn =
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/unknown-profile";
      const wrapped = wrapStream(arn);
      expect(invokeWrapped(wrapped, arn, "openai-completions")).toMatchObject({
        cacheRetention: "none",
      });
    });

    it("disables prompt caching for non-Anthropic Bedrock models", () => {
      const modelId = "amazon.nova-micro-v1:0";
      const wrapped = wrapStream(modelId);
      expect(invokeWrapped(wrapped, modelId, "openai-completions")).toMatchObject({
        cacheRetention: "none",
      });
    });
  });

  describe("guardrail config schema", () => {
    it("defines guardrail object with correct property types, required fields, and enums", () => {
      const pluginJson = JSON.parse(
        readFileSync(resolve(import.meta.dirname, "openclaw.plugin.json"), "utf-8"),
      );
      const guardrail = pluginJson.configSchema?.properties?.guardrail;

      expect(guardrail).toBeDefined();
      expect(guardrail.type).toBe("object");
      expect(guardrail.additionalProperties).toBe(false);

      // Required fields
      expect(guardrail.required).toEqual(["guardrailIdentifier", "guardrailVersion"]);

      // Property types
      expect(guardrail.properties.guardrailIdentifier).toEqual({ type: "string" });
      expect(guardrail.properties.guardrailVersion).toEqual({ type: "string" });

      // Enum constraints
      expect(guardrail.properties.streamProcessingMode).toEqual({
        type: "string",
        enum: ["sync", "async"],
      });
      expect(guardrail.properties.trace).toEqual({
        type: "string",
        enum: ["enabled", "disabled", "enabled_full"],
      });
    });
  });

  describe("guardrail payload injection", () => {
    it("does not inject guardrailConfig when guardrail is absent from plugin config", () => {
      const provider = registerWithConfig(undefined);
      const result = callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      expect(result).not.toHaveProperty("_capturedPayload");
      // The onPayload hook should not exist when no guardrail is configured
      expect(result).toMatchObject({ cacheRetention: "none" });
    });

    it("injects all four fields when guardrail config includes optional fields", () => {
      const provider = registerWithConfig({
        guardrail: {
          guardrailIdentifier: "my-guardrail-id",
          guardrailVersion: "1",
          streamProcessingMode: "sync",
          trace: "enabled",
        },
      });
      const result = callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "my-guardrail-id",
          guardrailVersion: "1",
          streamProcessingMode: "sync",
          trace: "enabled",
        },
      });
    });

    it("injects only required fields when optional fields are omitted", () => {
      const provider = registerWithConfig({
        guardrail: {
          guardrailIdentifier: "abc123",
          guardrailVersion: "DRAFT",
        },
      });
      const result = callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "abc123",
          guardrailVersion: "DRAFT",
        },
      });
    });

    it("injects guardrailConfig for Anthropic models without cacheRetention: none", () => {
      const provider = registerWithConfig({
        guardrail: {
          guardrailIdentifier: "guardrail-anthropic",
          guardrailVersion: "2",
          streamProcessingMode: "async",
          trace: "disabled",
        },
      });
      const result = callWrappedStream(provider, ANTHROPIC_MODEL, ANTHROPIC_MODEL_DESCRIPTOR);

      // Anthropic models should get guardrailConfig
      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "guardrail-anthropic",
          guardrailVersion: "2",
          streamProcessingMode: "async",
          trace: "disabled",
        },
      });
      // Anthropic models should NOT get cacheRetention: "none"
      expect(result).not.toHaveProperty("cacheRetention", "none");
    });

    it("injects guardrailConfig for non-Anthropic models with cacheRetention: none", () => {
      const provider = registerWithConfig({
        guardrail: {
          guardrailIdentifier: "guardrail-nova",
          guardrailVersion: "3",
        },
      });
      const result = callWrappedStream(provider, NON_ANTHROPIC_MODEL, MODEL_DESCRIPTOR);

      // Non-Anthropic models should get guardrailConfig
      expect(result._capturedPayload).toEqual({
        guardrailConfig: {
          guardrailIdentifier: "guardrail-nova",
          guardrailVersion: "3",
        },
      });
      // Non-Anthropic models should also get cacheRetention: "none"
      expect(result).toMatchObject({ cacheRetention: "none" });
    });
  });

  describe("region injection", () => {
    it("injects region from bedrockDiscovery config", () => {
      const modelId = "eu.anthropic.claude-sonnet-4-6";
      const wrapped = wrapStream(modelId, {
        models: { bedrockDiscovery: { region: "eu-west-1" } },
      });
      expect(invokeWrapped(wrapped, modelId)).toMatchObject({ region: "eu-west-1" });
    });

    it("injects region extracted from provider baseUrl", () => {
      const modelId = "eu.anthropic.claude-sonnet-4-6";
      const wrapped = wrapStream(modelId, {
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: "https://bedrock-runtime.eu-central-1.amazonaws.com",
              models: [],
            },
          },
        },
      });
      expect(invokeWrapped(wrapped, modelId)).toMatchObject({ region: "eu-central-1" });
    });

    it("prefers provider baseUrl region over bedrockDiscovery region", () => {
      const modelId = "eu.anthropic.claude-sonnet-4-6";
      const wrapped = wrapStream(modelId, {
        models: {
          bedrockDiscovery: { region: "us-east-1" },
          providers: {
            "amazon-bedrock": {
              baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com",
              models: [],
            },
          },
        },
      });
      expect(invokeWrapped(wrapped, modelId)).toMatchObject({ region: "eu-west-1" });
    });

    it("does not inject region when neither bedrockDiscovery nor baseUrl is configured", () => {
      const result = wrapStream("anthropic.claude-sonnet-4-6");
      expect(result).toBe(passThroughFn);
    });
  });
});
