import "../../test-utils/prepare-compiled-subprocesses.js";
import { createLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import type { Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";

describe("embedded stream transport host", () => {
  it("installs runtime transport ports before resolving an embedded stream", async () => {
    const inertResolver = getAiTransportHost().plugin.resolveProviderStream;
    const { resolveEmbeddedAgentStream } = await import("./stream-resolution.js");
    const model = makeProviderModelFixture({
      api: "test-embedded-runtime-host-api",
      provider: "test-embedded-runtime-host",
      id: "test-embedded-runtime-host-model",
      name: "Test Embedded Runtime Host Model",
      baseUrl: "https://example.test",
      contextWindow: 1024,
      maxTokens: 512,
    }) satisfies Model;
    const resolver = getAiTransportHost().plugin.resolveProviderStream;

    expect(resolver).not.toBe(inertResolver);
    expect(
      resolver({
        provider: model.provider,
        context: {
          provider: model.provider,
          modelId: model.id,
          model,
        },
      }),
    ).toBeUndefined();
    expect(
      resolveEmbeddedAgentStream({
        sessionId: "session-1",
        llmRuntime: createLlmRuntime(),
        currentStreamFn: undefined,
        model,
      }).strategy,
    ).toBe("stream-simple");
  });
});
