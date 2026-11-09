import { expect } from "vitest";
import type { startQaMockOpenAiServer } from "./server.js";
import {
  type MockServer,
  expectNonStreamingResponsesJson,
  expectOpenAiNonStreamingResponsesJson,
  expectResponses,
  requireRecord,
  makeUserInput,
  postResponses,
} from "./server.test-harness.js";

type Options = Record<string, unknown>;

export function settleParent(
  server: Pick<Awaited<ReturnType<typeof startQaMockOpenAiServer>>, "terminalRequesters">,
  sessionId: string,
  key = "agent:qa:main",
) {
  return server.terminalRequesters.settle({
    call: async () => ({
      sessions: [
        {
          key,
          agentId: "qa",
          sessionId,
          hasActiveRun: false,
          status: "done",
          abortedLastRun: false,
        },
      ],
    }),
  });
}

export function userInputs(...items: (string | Record<string, unknown>)[]) {
  return items.map((item) => (typeof item === "string" ? makeUserInput(item) : item));
}

function requestWith<T>(send: (server: MockServer, body: Options) => T, defaults: Options = {}) {
  return (server: MockServer, input: unknown, options: Options = {}) =>
    send(server, {
      ...defaults,
      ...options,
      // A bare string is one user turn; structured wire inputs pass through unchanged.
      input: typeof input === "string" ? [makeUserInput(input)] : input,
    });
}

const openAi = { model: "gpt-5.6-luna" };
export const respond = requestWith(expectNonStreamingResponsesJson);
export const respondOpenAi = requestWith(expectOpenAiNonStreamingResponsesJson);
export const readResponse = requestWith(expectResponses, { stream: false });
export const responseOpenAi = requestWith(expectResponses, { stream: false, ...openAi });
export const streamResponse = requestWith(expectResponses, { stream: true });
export const streamOpenAi = requestWith(expectResponses, { stream: true, ...openAi });
export const postPlain = requestWith(postResponses, { stream: false });
export const postStream = requestWith(postResponses, { stream: true });

async function responseText(server: MockServer, body: Options) {
  return (await expectResponses(server, body)).text();
}
export const streamText = requestWith(responseText, { stream: true });
export const streamOpenAiText = requestWith(responseText, { stream: true, ...openAi });

export function functionCall(name: string, args: unknown, callId?: string) {
  return {
    type: "function_call",
    name,
    ...(callId === undefined ? {} : { call_id: callId }),
    arguments: JSON.stringify(args),
  };
}

export function anthropicCall(name: string, input: unknown, id: unknown) {
  return { role: "assistant", content: [{ type: "tool_use", name, input, id }] };
}

export function completedResult(value: unknown) {
  return JSON.stringify({ status: "completed", value });
}

export function textBlock(text: string) {
  return { type: "input_text", text };
}

export function expectIncludes(text: string, ...parts: string[]) {
  for (const part of parts) {
    expect(text).toContain(part);
  }
}

export function expectExcludes(text: string, ...parts: string[]) {
  for (const part of parts) {
    expect(text).not.toContain(part);
  }
}

export function expectResponseText(payload: unknown, text: string) {
  expect(payload).toMatchObject({ output: [{ content: [{ text }] }] });
}

export function expectAnthropicText(payload: unknown, text: string) {
  expect(payload).toMatchObject({ stop_reason: "end_turn", content: [{ type: "text", text }] });
}

export function expectSlots(events: Record<string, unknown>[], ids: unknown[]) {
  const types = ["response.output_item.added", "response.output_item.done"];
  expect(
    events
      .filter(({ type }) => types.some((expected) => type === expected))
      .map(({ type, item, output_index: i }) => [type, requireRecord(item, "output item").id, i]),
  ).toEqual(ids.flatMap((id, index) => types.map((type) => [type, id, index])));
}
