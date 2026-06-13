import { describe, expect, it } from "vitest";
import {
  getInworldReasoningLevels,
  type InworldCatalogModel,
  isInworldCacheTtlModel,
  parseInworldModel,
  toInworldWireModelId,
} from "./models.js";

const SONNET_ENTRY: InworldCatalogModel = {
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  pricing: {
    promptToken: 0.000003,
    completionToken: 0.000015,
    promptCacheReadToken: 3e-7,
    promptCacheWriteToken: 0.00000375,
  },
  spec: {
    inputModalities: ["text", "image"],
    contextLength: 1_000_000,
    maxCompletionTokens: 64_000,
    capabilities: {
      functionCalling: true,
      reasoning: true,
      vision: true,
    },
  },
  isSupported: true,
};

describe("parseInworldModel", () => {
  it("maps a fully-populated entry to a ModelDefinitionConfig", () => {
    const parsed = parseInworldModel(SONNET_ENTRY);
    expect(parsed).toMatchObject({
      id: "anthropic/claude-sonnet-4-6",
      name: "anthropic/claude-sonnet-4-6",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      compat: { supportsTools: true },
    });
  });

  it("scales per-token pricing to per-million-token", () => {
    const parsed = parseInworldModel(SONNET_ENTRY);
    expect(parsed?.cost).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    });
  });

  it("rejects entries missing a model id", () => {
    expect(parseInworldModel({ ...SONNET_ENTRY, model: undefined })).toBeUndefined();
  });

  it("rejects entries flagged isSupported=false", () => {
    expect(parseInworldModel({ ...SONNET_ENTRY, isSupported: false })).toBeUndefined();
  });

  it("defaults to text-only when no image modality or vision is present", () => {
    const parsed = parseInworldModel({
      ...SONNET_ENTRY,
      spec: { ...SONNET_ENTRY.spec, inputModalities: ["text"], capabilities: {} },
    });
    expect(parsed?.input).toEqual(["text"]);
  });

  it("adds image modality when capabilities.vision is true even without inputModalities", () => {
    const parsed = parseInworldModel({
      ...SONNET_ENTRY,
      spec: {
        ...SONNET_ENTRY.spec,
        inputModalities: undefined,
        capabilities: { vision: true },
      },
    });
    expect(parsed?.input).toEqual(["text", "image"]);
  });

  it("omits compat when functionCalling is absent", () => {
    const parsed = parseInworldModel({
      ...SONNET_ENTRY,
      spec: { ...SONNET_ENTRY.spec, capabilities: {} },
    });
    expect(parsed?.compat).toBeUndefined();
  });

  it("stores first-party Inworld models without the inworld/ provider prefix", () => {
    const parsed = parseInworldModel({
      model: "models/GLM-5.1",
      provider: "inworld",
      isSupported: true,
      spec: { capabilities: { functionCalling: true } },
    });
    expect(parsed?.id).toBe("models/GLM-5.1");
  });

  it("concatenates upstream provider and model name for non-first-party catalog ids", () => {
    const parsed = parseInworldModel({
      model: "claude-opus-4-8",
      provider: "anthropic",
      isSupported: true,
      spec: { capabilities: { functionCalling: true } },
    });
    expect(parsed?.id).toBe("anthropic/claude-opus-4-8");
  });

  it("rewrites first-party ids to the inworld/models/<NAME> wire format", () => {
    expect(toInworldWireModelId("models/GLM-5.1")).toBe("inworld/models/GLM-5.1");
    expect(toInworldWireModelId("anthropic/claude-opus-4-8")).toBe("anthropic/claude-opus-4-8");
    expect(toInworldWireModelId("auto")).toBe("auto");
  });

  it("captures reasoning supportedLevels and prompt-caching flag from the catalog", () => {
    parseInworldModel({
      model: "claude-opus-4-8",
      provider: "anthropic",
      isSupported: true,
      spec: {
        capabilities: {
          functionCalling: true,
          reasoning: true,
          promptCaching: true,
          reasoningCapability: {
            supportedLevels: [
              "EFFORT_NONE",
              "EFFORT_MINIMAL",
              "EFFORT_LOW",
              "EFFORT_MEDIUM",
              "EFFORT_HIGH",
              "EFFORT_XHIGH",
            ],
          },
        },
      },
    });
    expect(getInworldReasoningLevels("anthropic/claude-opus-4-8")).toEqual([
      "EFFORT_NONE",
      "EFFORT_MINIMAL",
      "EFFORT_LOW",
      "EFFORT_MEDIUM",
      "EFFORT_HIGH",
      "EFFORT_XHIGH",
    ]);
    expect(isInworldCacheTtlModel("anthropic/claude-opus-4-8")).toBe(true);
  });
});
