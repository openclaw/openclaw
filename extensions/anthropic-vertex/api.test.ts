import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeAll, describe, expect, it } from "vitest";
import type { AnthropicVertexStreamDeps } from "./stream-runtime.js";
import { createStreamDeps } from "./stream.test-support.js";

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

  it.each([
    {
      name: "direct",
      create: (deps: AnthropicVertexStreamDeps) =>
        createAnthropicVertexStreamFn("vertex-project", "us-east5", undefined, deps),
    },
    {
      name: "model-derived",
      create: (deps: AnthropicVertexStreamDeps) =>
        createAnthropicVertexStreamFnForModel(
          makeModel(),
          {
            ANTHROPIC_VERTEX_PROJECT_ID: "vertex-project",
            GOOGLE_CLOUD_LOCATION: "us-east5",
          },
          deps,
        ),
    },
  ])("reuses the runtime stream factory across $name calls", async ({ create }) => {
    const { deps, streamAnthropicMock, anthropicVertexCtorMock } = createStreamDeps();
    const streamFn = create(deps);
    const model = makeModel();
    await streamFn(model, { messages: [] }, {});
    await streamFn(model, { messages: [] }, {});
    expect(anthropicVertexCtorMock).toHaveBeenCalledTimes(1);
    expect(streamAnthropicMock).toHaveBeenCalledTimes(2);
  });
});
