import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiRegistry, createAssistantMessageEventStream, createLlmRuntime } from "./index.js";
import {
  defaultApiRegistry,
  streamSimple as streamSimpleDefault,
} from "./internal/default-runtime.js";
import { anthropicModel } from "./provider-transport-parity.test-support.js";

const TEST_SOURCE_ID = "test:llm-runtime-api-registry";
const emptyStream = () => createAssistantMessageEventStream();
const makeProvider = (api = "test-api", streamSimple = emptyStream) => ({
  api,
  stream: emptyStream,
  streamSimple,
});

const model = { ...anthropicModel, api: "test-api" };

describe("LLM API registry", () => {
  afterEach(() => {
    defaultApiRegistry.unregisterApiProviders(TEST_SOURCE_ID);
  });

  it("rejects mismatched model API calls", () => {
    const registry = createApiRegistry();
    registry.registerApiProvider(makeProvider(), TEST_SOURCE_ID);

    const provider = registry.getApiProvider("test-api");
    expect(() => provider?.streamSimple({ ...model, api: "other-api" }, { messages: [] })).toThrow(
      "Mismatched api: other-api expected test-api",
    );
  });

  it("isolates providers between runtime instances", () => {
    const first = createLlmRuntime();
    const second = createLlmRuntime();
    const streamSimple = vi.fn(emptyStream);
    first.registry.registerApiProvider({ api: "test-api", stream: streamSimple, streamSimple });

    first.streamSimple(model, { messages: [] });

    expect(streamSimple).toHaveBeenCalledOnce();
    expect(() => second.streamSimple(model, { messages: [] })).toThrow(
      "No API provider registered for api: test-api",
    );
  });

  it("shares default runtime registrations across duplicated module instances", async () => {
    // File URLs preserve the cache-busting query through Vitest project shards.
    // Computed relative imports can escape into unresolved Vite /@fs paths.
    const duplicateRuntime = (await import(
      /* @vite-ignore */ new URL("./internal/default-runtime.ts?duplicate-runtime", import.meta.url)
        .href
    )) as typeof import("./internal/default-runtime.js");
    const streamSimple = vi.fn(emptyStream);
    duplicateRuntime.defaultApiRegistry.registerApiProvider(
      makeProvider("test-api", streamSimple),
      TEST_SOURCE_ID,
    );

    streamSimpleDefault(model, { messages: [] });

    expect(streamSimple).toHaveBeenCalledOnce();
  });

  it("unregisters every provider owned by one source", () => {
    const registry = createApiRegistry();
    for (const api of ["test-api", "test-api-2"] as const) {
      registry.registerApiProvider(makeProvider(api), TEST_SOURCE_ID);
    }

    registry.unregisterApiProviders(TEST_SOURCE_ID);

    expect(registry.getApiProviders()).toEqual([]);
  });
});
