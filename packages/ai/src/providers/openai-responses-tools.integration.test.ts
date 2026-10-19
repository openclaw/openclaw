import { afterEach, beforeEach, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createLlmRuntime } from "../stream.js";
import { createOpenAIResponsesTransportStreamFn } from "../transports/openai-responses-client.js";
import {
  createResponsesLoopbackServer,
  responsesLoopbackModel,
} from "../transports/openai-responses-loopback.test-support.js";
import type { Context, Tool } from "../types.js";
import { registerBuiltInApiProviders } from "./register-builtins.js";

const options = { apiKey: "synthetic-key", cacheRetention: "none" as const };
const contextFor = (tools: Tool[]): Context => ({
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools,
});
let server: Awaited<ReturnType<typeof createResponsesLoopbackServer>>;
beforeEach(async () => {
  server = await createResponsesLoopbackServer(completedResponseEvents);
});
afterEach(async () => {
  configureAiTransportHost({});
  await server.close();
});
const runtime = () => {
  const instance = createLlmRuntime();
  registerBuiltInApiProviders(instance.registry);
  return instance;
};
function wireTool(name: string, parameters: unknown, strict?: boolean, description?: string) {
  return {
    type: "function",
    name,
    ...(description === undefined ? {} : { description }),
    parameters,
    ...(strict === undefined ? {} : { strict }),
  };
}
function completedResponseEvents() {
  return [
    {
      type: "response.completed",
      response: {
        id: "resp_tools",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_tools",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "done", annotations: [] }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
}

it.each(
  (["provider", "transport"] as const).flatMap((entrypoint) =>
    [
      { native: false, supportsStrictMode: true, strict: false },
      { native: false, supportsStrictMode: false, strict: undefined },
      { native: false, supportsStrictMode: undefined, strict: undefined },
      { native: true, supportsStrictMode: undefined, strict: true },
    ].map((settings) => Object.assign({ entrypoint }, settings)),
  ),
)("serializes $entrypoint Responses tools with strict=$strict", async (scenario) => {
  const { entrypoint, native, supportsStrictMode, strict } = scenario;
  const capabilities = getAiTransportHost().resolveProviderRequestCapabilities({});
  configureAiTransportHost({
    resolveProviderRequestCapabilities: () => ({
      ...capabilities,
      endpointClass: native ? "openai-public" : "custom",
    }),
    resolveOpenAIStrictToolSetting: (_model, settings) =>
      native ? true : settings?.supportsStrictMode ? false : undefined,
  });
  const model = { ...responsesLoopbackModel, compat: { supportsStrictMode } };
  const parameters = Object.freeze({
    type: "object",
    properties: Object.freeze({ prompt: { type: "string" }, note: { type: "string" } }),
    required: Object.freeze(native ? ["prompt", "note"] : ["prompt"]),
    additionalProperties: false,
  });
  let descriptionReads = 0;
  const tools: Tool[] = [
    { name: "zeta", description: "Last", parameters },
    {
      name: "alpha",
      get description(): string {
        descriptionReads += 1;
        throw new Error("Optional description is unavailable");
      },
      parameters,
    },
  ];
  const context = contextFor(tools);
  const expectedTools = [
    wireTool("alpha", parameters, strict),
    wireTool("zeta", parameters, strict, "Last"),
  ];
  const lifecycle: string[] = [];
  const requestOptions = {
    ...options,
    transport: "sse" as const,
    onPayload: () => {
      lifecycle.push("payload");
    },
    onResponse: () => {
      lifecycle.push("response");
    },
  };
  const owner = runtime();
  for (let request = 0; request < 2; request++) {
    const stream =
      entrypoint === "provider"
        ? owner.stream(model, context, requestOptions)
        : await createOpenAIResponsesTransportStreamFn()(model, context, requestOptions);
    for await (const event of stream) {
      if (event.type === "start" || event.type === "done" || event.type === "error") {
        lifecycle.push(event.type);
      }
    }
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "done" })]);
    expect(result.usage).toMatchObject({ input: 5, output: 3, totalTokens: 8 });
  }
  expect(lifecycle).toEqual(
    Array.from({ length: 2 }, () => ["payload", "response", "start", "done"]).flat(),
  );
  expect(server.requests).toHaveLength(2);
  for (let request = 0; request < 2; request++) {
    expect(server.requests[request]?.tools).toEqual(expectedTools);
    expect(server.rawRequests[request]).toContain(`"tools":${JSON.stringify(expectedTools)}`);
  }
  expect(descriptionReads).toBe(2);
  expect(tools.map((tool) => tool.name)).toEqual(["zeta", "alpha"]);
  expect(tools.every((tool) => tool.parameters === parameters)).toBe(true);
});

it("sends strict=false when a Responses tool pattern uses a regex lookaround", async () => {
  configureAiTransportHost({ resolveOpenAIStrictToolSetting: () => true });
  const parameters = {
    type: "object",
    properties: {
      filename: { type: "string", pattern: "^(?![\\\\/])(?![A-Za-z]:)(?!.*\\.\\.).+$" },
      folder: { type: "string" },
      content: { type: "string" },
    },
    required: ["folder", "filename", "content"],
    additionalProperties: false,
  };
  const context = contextFor([{ name: "create_file", description: "Create", parameters }]);
  const stream = await createOpenAIResponsesTransportStreamFn()(
    responsesLoopbackModel,
    context,
    options,
  );
  expect((await stream.result()).stopReason).toBe("stop");
  expect(server.requests[0]?.tools).toEqual([wireTool("create_file", parameters, false, "Create")]);
});

it("reports one strict downgrade across Responses entrypoints without changing the wire schema", async () => {
  const diagnostics: Array<{ subsystem: string; message: string; data?: unknown }> = [];
  configureAiTransportHost({
    resolveOpenAIStrictToolSetting: () => true,
    logDebug: (subsystem, build) => {
      const entry = build();
      if (entry?.message.includes("strict mode downgraded")) {
        diagnostics.push({ subsystem, ...entry });
      }
    },
  });
  const model = { ...responsesLoopbackModel, id: "strict-diagnostic-loopback" };
  const parameters = {
    type: "object",
    properties: { value: { type: "integer" } },
    required: [],
    additionalProperties: false,
  };
  const context = contextFor([{ name: "record_value", description: "Record", parameters }]);
  const owner = runtime();
  for (const stream of [
    () => owner.stream(model, context, options),
    () => createOpenAIResponsesTransportStreamFn()(model, context, options),
  ]) {
    expect((await (await stream()).result()).stopReason).toBe("stop");
  }
  expect(server.requests.map((request) => request.tools)).toEqual(
    Array.from({ length: 2 }, () => [wireTool("record_value", parameters, false, "Record")]),
  );
  expect(diagnostics).toEqual([
    {
      subsystem: "openai-transport",
      message: expect.stringContaining("OpenAI responses tool schema strict mode downgraded"),
      data: expect.objectContaining({
        transport: "responses",
        provider: model.provider,
        model: model.id,
        incompatibleToolCount: 1,
        sample: [expect.objectContaining({ tool: "record_value" })],
      }),
    },
  ]);
});
