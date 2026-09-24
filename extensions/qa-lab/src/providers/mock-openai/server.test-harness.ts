import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect } from "vitest";
import type { QaMockOpenAiServerOptions } from "./server-options.js";
import { startQaMockOpenAiServer } from "./server.js";

export type MockServer = { baseUrl: string };

export const QA_SETTLED_TOOL_TERMINAL_CONTINUATION_INSTRUCTION =
  "The previous assistant turn completed its tool calls but did not produce a user-visible answer. Continue from the current transcript and produce the final user-visible answer now. Do not repeat completed tool calls or restart from scratch. Tools are unavailable in this step: it is a text-only pass, so reply with plain text and do not attempt any tool call.";

export function createMockServerTestHarness() {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  async function startMockServer(params?: QaMockOpenAiServerOptions) {
    const server = await startQaMockOpenAiServer({
      host: "127.0.0.1",
      port: 0,
      ...params,
    });
    cleanups.push(async () => {
      await server.stop();
    });
    return server;
  }

  return { startMockServer, cleanups };
}

export const requireRecord = createRequireRecord("record", "expected-label-capitalized");

export async function postJson(
  server: MockServer,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
) {
  return fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

export async function expectOk(responsePromise: Promise<Response>) {
  const response = await responsePromise;
  expect(response.status).toBe(200);
  return response;
}

export function fetchOk(input: URL | RequestInfo, init?: RequestInit) {
  return expectOk(fetch(input, init));
}

export async function fetchOkJson<T>(input: URL | RequestInfo, init?: RequestInit) {
  return (await fetchOk(input, init)).json() as Promise<T>;
}

export function getJson<T>(server: MockServer, path: string) {
  return fetchOkJson<T>(`${server.baseUrl}${path}`);
}

export async function postResponses(server: MockServer, body: unknown) {
  return postJson(server, "/v1/responses", body);
}

export function expectResponses(server: MockServer, body: unknown) {
  return expectOk(postResponses(server, body));
}

export async function expectResponsesJson<T>(server: MockServer, body: unknown) {
  return (await expectResponses(server, body)).json() as Promise<T>;
}

export function expectNonStreamingResponsesJson<T>(
  server: MockServer,
  body: Record<string, unknown>,
) {
  return expectResponsesJson<T>(server, { stream: false, ...body });
}

export function expectOpenAiNonStreamingResponsesJson<T>(
  server: MockServer,
  body: Record<string, unknown>,
) {
  return expectNonStreamingResponsesJson<T>(server, { model: "gpt-5.6-luna", ...body });
}

export function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

export function outputItem(payload: unknown, index = 0) {
  const output = requireArray(requireRecord(payload, "response payload").output, "response output");
  return requireRecord(output[index], `response output ${index}`);
}

export function outputItems(payload: unknown) {
  return requireArray(requireRecord(payload, "response payload").output, "response output").map(
    (item, index) => requireRecord(item, `response output ${index}`),
  );
}

export function outputToolArgs(payload: unknown, index = 0) {
  const item = outputItem(payload, index);
  return outputToolArgsFromItem(item);
}

export function outputToolArgsFromItem(item: Record<string, unknown>) {
  if (typeof item.arguments !== "string") {
    throw new Error("Expected response output arguments");
  }
  return requireRecord(JSON.parse(item.arguments) as unknown, "response output arguments");
}

export function outputToolCall(payload: unknown, name: string) {
  const toolCall = outputItems(payload).find(
    (item) => item.type === "function_call" && item.name === name,
  );
  if (!toolCall) {
    throw new Error(`Expected ${name} tool call`);
  }
  return toolCall;
}

export function outputToolCallId(item: Record<string, unknown>, fallback: string) {
  return typeof item.call_id === "string" ? item.call_id : fallback;
}

export function outputContentItem(payload: unknown, outputIndex = 0, contentIndex = 0) {
  const content = requireArray(outputItem(payload, outputIndex).content, "response output content");
  return requireRecord(content[contentIndex], `response content ${contentIndex}`);
}

export function outputText(payload: unknown, outputIndex = 0, contentIndex = 0) {
  const text = outputContentItem(payload, outputIndex, contentIndex).text;
  if (typeof text !== "string") {
    throw new Error("Expected response output text");
  }
  return text;
}

export function makeUserInput(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "input_text" as const, text }],
  };
}

export function makeToolOutputWithCallId(callId: string, output: unknown) {
  return { type: "function_call_output" as const, call_id: callId, output };
}
