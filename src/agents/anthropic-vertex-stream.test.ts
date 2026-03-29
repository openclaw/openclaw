import type { Model } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const streamAnthropicMock = vi.fn<(model: unknown, context: unknown, options: unknown) => symbol>(
    () => Symbol("anthropic-vertex-stream"),
  );
  const anthropicVertexCtorMock = vi.fn();

  return {
    streamAnthropicMock,
    anthropicVertexCtorMock,
  };
});

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...original,
    streamAnthropic: (model: unknown, context: unknown, options: unknown) =>
      hoisted.streamAnthropicMock(model, context, options),
  };
});

vi.mock("@anthropic-ai/vertex-sdk", () => ({
  AnthropicVertex: vi.fn(function MockAnthropicVertex(options: unknown) {
    hoisted.anthropicVertexCtorMock(options);
    return { options };
  }),
}));

import {
  resolveAnthropicVertexRegion,
  resolveAnthropicVertexRegionFromBaseUrl,
} from "../plugin-sdk/anthropic-vertex.js";

let createAnthropicVertexStreamFn: typeof import("./anthropic-vertex-stream.js").createAnthropicVertexStreamFn;
let createAnthropicVertexStreamFnForModel: typeof import("./anthropic-vertex-stream.js").createAnthropicVertexStreamFnForModel;

async function loadFreshAnthropicVertexStreamModuleForTest() {
  vi.resetModules();
  vi.doMock("@mariozechner/pi-ai", async (importOriginal) => {
    const original = await importOriginal<typeof import("@mariozechner/pi-ai")>();
    return {
      ...original,
      streamAnthropic: (model: unknown, context: unknown, options: unknown) =>
        hoisted.streamAnthropicMock(model, context, options),
    };
  });
  vi.doMock("@anthropic-ai/vertex-sdk", () => ({
    AnthropicVertex: vi.fn(function MockAnthropicVertex(options: unknown) {
      hoisted.anthropicVertexCtorMock(options);
      return { options };
    }),
  }));
  return await import("./anthropic-vertex-stream.js");
}

function makeModel(params: { id: string; maxTokens?: number }): Model<"anthropic-messages"> {
  return {
    id: params.id,
    api: "anthropic-messages",
    provider: "anthropic-vertex",
    ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
  } as Model<"anthropic-messages">;
}

describe("createAnthropicVertexStreamFn", () => {
  beforeEach(() => {
    hoisted.streamAnthropicMock.mockClear();
    hoisted.anthropicVertexCtorMock.mockClear();
  });

  beforeEach(async () => {
    ({ createAnthropicVertexStreamFn, createAnthropicVertexStreamFnForModel } =
      await loadFreshAnthropicVertexStreamModuleForTest());
  });

  it("omits projectId when ADC credentials are used without an explicit project", () => {
    const streamFn = createAnthropicVertexStreamFn(undefined, "global");

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 }), { messages: [] }, {});

    expect(hoisted.anthropicVertexCtorMock).toHaveBeenCalledWith({
      region: "global",
    });
  });

  it("passes an explicit baseURL through to the Vertex client", () => {
    const streamFn = createAnthropicVertexStreamFn(
      "vertex-project",
      "us-east5",
      "https://proxy.example.test/vertex/v1",
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 }), { messages: [] }, {});

    expect(hoisted.anthropicVertexCtorMock).toHaveBeenCalledWith({
      projectId: "vertex-project",
      region: "us-east5",
      baseURL: "https://proxy.example.test/vertex/v1",
    });
  });

  it("defaults maxTokens to the model limit instead of the old 32000 cap", () => {
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5");
    const model = makeModel({ id: "claude-opus-4-6", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, {});

    expect(hoisted.streamAnthropicMock).toHaveBeenCalledWith(
      model,
      { messages: [] },
      expect.objectContaining({
        maxTokens: 128000,
      }),
    );
  });

  it("clamps explicit maxTokens to the selected model limit", () => {
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5");
    const model = makeModel({ id: "claude-sonnet-4-6", maxTokens: 128000 });

    void streamFn(model, { messages: [] }, { maxTokens: 999999 });

    expect(hoisted.streamAnthropicMock).toHaveBeenCalledWith(
      model,
      { messages: [] },
      expect.objectContaining({
        maxTokens: 128000,
      }),
    );
  });

  it("maps xhigh reasoning to max effort for adaptive Opus models", () => {
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5");
    const model = makeModel({ id: "claude-opus-4-6", maxTokens: 64000 });

    void streamFn(model, { messages: [] }, { reasoning: "xhigh" });

    expect(hoisted.streamAnthropicMock).toHaveBeenCalledWith(
      model,
      { messages: [] },
      expect.objectContaining({
        thinkingEnabled: true,
        effort: "max",
      }),
    );
  });

  it("omits maxTokens when neither the model nor request provide a finite limit", () => {
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5");
    const model = makeModel({ id: "claude-sonnet-4-6" });

    void streamFn(model, { messages: [] }, { maxTokens: Number.NaN });

    expect(hoisted.streamAnthropicMock).toHaveBeenCalledWith(
      model,
      { messages: [] },
      expect.not.objectContaining({
        maxTokens: expect.anything(),
      }),
    );
  });
});

describe("resolveAnthropicVertexRegionFromBaseUrl", () => {
  it("accepts well-formed regional env values", () => {
    expect(
      resolveAnthropicVertexRegion({
        GOOGLE_CLOUD_LOCATION: "us-east1",
      } as NodeJS.ProcessEnv),
    ).toBe("us-east1");
  });

  it("falls back to the default region for malformed env values", () => {
    expect(
      resolveAnthropicVertexRegion({
        GOOGLE_CLOUD_LOCATION: "us-central1.attacker.example",
      } as NodeJS.ProcessEnv),
    ).toBe("global");
  });

  it("parses regional Vertex endpoints", () => {
    expect(
      resolveAnthropicVertexRegionFromBaseUrl("https://europe-west4-aiplatform.googleapis.com"),
    ).toBe("europe-west4");
  });

  it("treats the global Vertex endpoint as global", () => {
    expect(resolveAnthropicVertexRegionFromBaseUrl("https://aiplatform.googleapis.com")).toBe(
      "global",
    );
  });
});

describe("createAnthropicVertexStreamFnForModel", () => {
  beforeEach(() => {
    hoisted.anthropicVertexCtorMock.mockClear();
  });

  beforeEach(async () => {
    ({ createAnthropicVertexStreamFn, createAnthropicVertexStreamFnForModel } =
      await loadFreshAnthropicVertexStreamModuleForTest());
  });

  it("derives project and region from the model and env", () => {
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://europe-west4-aiplatform.googleapis.com" },
      { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" } as NodeJS.ProcessEnv,
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 }), { messages: [] }, {});

    expect(hoisted.anthropicVertexCtorMock).toHaveBeenCalledWith({
      projectId: "vertex-project",
      region: "europe-west4",
      baseURL: "https://europe-west4-aiplatform.googleapis.com/v1",
    });
  });

  it("preserves explicit custom provider base URLs", () => {
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://proxy.example.test/custom-root/v1" },
      { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" } as NodeJS.ProcessEnv,
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 }), { messages: [] }, {});

    expect(hoisted.anthropicVertexCtorMock).toHaveBeenCalledWith({
      projectId: "vertex-project",
      region: "global",
      baseURL: "https://proxy.example.test/custom-root/v1",
    });
  });

  it("adds /v1 for path-prefixed custom provider base URLs", () => {
    const streamFn = createAnthropicVertexStreamFnForModel(
      { baseUrl: "https://proxy.example.test/custom-root" },
      { GOOGLE_CLOUD_PROJECT_ID: "vertex-project" } as NodeJS.ProcessEnv,
    );

    void streamFn(makeModel({ id: "claude-sonnet-4-6", maxTokens: 64000 }), { messages: [] }, {});

    expect(hoisted.anthropicVertexCtorMock).toHaveBeenCalledWith({
      projectId: "vertex-project",
      region: "global",
      baseURL: "https://proxy.example.test/custom-root/v1",
    });
  });
});
