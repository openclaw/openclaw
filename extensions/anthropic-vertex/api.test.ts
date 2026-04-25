import type { Model } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const streamAnthropicMock = vi.fn(() => Symbol("anthropic-vertex-stream"));
  const anthropicVertexCtorMock = vi.fn();

  return {
    streamAnthropicMock,
    anthropicVertexCtorMock,
  };
});

vi.mock("@mariozechner/pi-ai", async () => {
  const original =
    await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...original,
    streamAnthropic: hoisted.streamAnthropicMock,
  };
});

vi.mock("@anthropic-ai/vertex-sdk", () => ({
  AnthropicVertex: vi.fn(function MockAnthropicVertex(options: unknown) {
    hoisted.anthropicVertexCtorMock(options);
    return { options };
  }),
}));

let createAnthropicVertexStreamFn: typeof import("./api.js").createAnthropicVertexStreamFn;
let createAnthropicVertexStreamFnForModel: typeof import("./api.js").createAnthropicVertexStreamFnForModel;

function makeModel(): Model<"anthropic-messages"> {
  return {
    id: "claude-sonnet-4-6",
    api: "anthropic-messages",
    provider: "anthropic-vertex",
    maxTokens: 128000,
  } as Model<"anthropic-messages">;
}

describe("Anthropic Vertex API stream factories", () => {
  beforeAll(async () => {
    ({ createAnthropicVertexStreamFn, createAnthropicVertexStreamFnForModel } =
      await import("./api.js"));
  });

  beforeEach(() => {
    hoisted.streamAnthropicMock.mockClear();
    hoisted.anthropicVertexCtorMock.mockClear();
  });

  it("reuses the runtime stream factory across direct stream calls", async () => {
    const streamFn = createAnthropicVertexStreamFn("vertex-project", "us-east5");
    const model = makeModel();

    await streamFn(model, { messages: [] }, {});
    await streamFn(model, { messages: [] }, {});

    expect(hoisted.anthropicVertexCtorMock).toHaveBeenCalledTimes(1);
    expect(hoisted.streamAnthropicMock).toHaveBeenCalledTimes(2);
  });

  it("reuses the runtime stream factory across model-derived stream calls", async () => {
    const streamFn = createAnthropicVertexStreamFnForModel(makeModel(), {
      ANTHROPIC_VERTEX_PROJECT_ID: "vertex-project",
      GOOGLE_CLOUD_LOCATION: "us-east5",
    } as NodeJS.ProcessEnv);
    const model = makeModel();

    await streamFn(model, { messages: [] }, {});
    await streamFn(model, { messages: [] }, {});

    expect(hoisted.anthropicVertexCtorMock).toHaveBeenCalledTimes(1);
    expect(hoisted.streamAnthropicMock).toHaveBeenCalledTimes(2);
  });
});
