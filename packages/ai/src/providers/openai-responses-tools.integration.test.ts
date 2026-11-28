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
      // An undeclared custom endpoint sends tools exactly as before: no strict field.
      { endpointClass: "custom", supportsStrictMode: undefined, strict: undefined },
      { endpointClass: "custom", supportsStrictMode: false, strict: undefined },
      { endpointClass: "custom", supportsStrictMode: true, strict: false },
      { endpointClass: "openai-public", supportsStrictMode: undefined, strict: false },
    ].map((settings) => Object.assign({ entrypoint }, settings)),
  ),
)(
  "serializes $entrypoint Responses tools for $endpointClass with strict=$strict",
  async (scenario) => {
    const { entrypoint, endpointClass, supportsStrictMode, strict } = scenario;
    const capabilities = getAiTransportHost().resolveProviderRequestCapabilities({});
    configureAiTransportHost({
      resolveProviderRequestCapabilities: () => ({ ...capabilities, endpointClass }),
    });
    const model = { ...responsesLoopbackModel, compat: { supportsStrictMode } };
    const parameters = Object.freeze({
      ...schema(Object.freeze({ prompt: string, note: string })),
      required: Object.freeze(["prompt", "note"]),
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
  },
);
