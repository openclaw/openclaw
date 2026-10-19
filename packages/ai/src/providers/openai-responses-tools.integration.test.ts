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
const transport = createOpenAIResponsesTransportStreamFn();
const string = { type: "string" };
const filename = { type: "string", pattern: "^(?![\\\\/])(?![A-Za-z]:)(?!.*\\.\\.).+$" };
function schema(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return { type: "object", properties, required, additionalProperties: false };
}
const contextFor = (tools: Tool[]): Context => ({
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools,
});
let server: Awaited<ReturnType<typeof createResponsesLoopbackServer>>;
let owner: ReturnType<typeof createLlmRuntime>;
beforeEach(async () => {
  server = await createResponsesLoopbackServer(completedResponseEvents);
  owner = createLlmRuntime();
  registerBuiltInApiProviders(owner.registry);
});
afterEach(async () => {
  configureAiTransportHost({});
  await server.close();
});
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
        status: "completed",
        output: [
          { type: "message", id: "msg_tools", content: [{ type: "output_text", text: "done" }] },
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
    ...schema(Object.freeze({ prompt: string, note: string })),
    required: Object.freeze(native ? ["prompt", "note"] : ["prompt"]),
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
    onPayload: () => void lifecycle.push("payload"),
    onResponse: () => void lifecycle.push("response"),
  };
  for (let request = 0; request < 2; request++) {
    const stream =
      entrypoint === "provider"
        ? owner.stream(model, context, requestOptions)
        : await transport(model, context, requestOptions);
    for await (const event of stream) {
      if (event.type === "start" || event.type === "done" || event.type === "error") {
        lifecycle.push(event.type);
      }
    }
    expect(await stream.result()).toMatchObject({
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
      usage: { input: 5, output: 3, totalTokens: 8 },
    });
  }
  const turn = ["payload", "response", "start", "done"];
  expect(lifecycle).toEqual([...turn, ...turn]);
  expect(server.requests.map((request) => request.tools)).toEqual([expectedTools, expectedTools]);
  const wire = expect.stringContaining(`"tools":${JSON.stringify(expectedTools)}`);
  expect(server.rawRequests).toEqual([wire, wire]);
  expect(descriptionReads).toBe(2);
  expect(tools.map((tool) => tool.name)).toEqual(["zeta", "alpha"]);
  expect(tools.every((tool) => tool.parameters === parameters)).toBe(true);
});

it.each([
  { name: "regex lookaround", parameters: schema({ filename }) },
  { name: "optional property", parameters: schema({ value: { type: "integer" } }, []) },
])(
  "reports one $name strict downgrade without changing either entrypoint's wire schema",
  async ({ name, parameters }) => {
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
    const model = { ...responsesLoopbackModel, id: `strict-diagnostic-${name}` };
    const context = contextFor([{ name: "record_value", description: "Record", parameters }]);
    for (const stream of [
      () => owner.stream(model, context, options),
      () => transport(model, context, options),
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
  },
);
