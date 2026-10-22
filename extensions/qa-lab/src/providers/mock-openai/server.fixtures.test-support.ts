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

function requestInput(input: unknown) {
  // A bare string is shorthand for one user turn; raw wire inputs use the harness directly.
  return typeof input === "string" ? [makeUserInput(input)] : input;
}

// Keep transport/model choices explicit while sharing the repeated request envelope.
export function respond(server: MockServer, input: unknown, options: Options = {}) {
  return expectNonStreamingResponsesJson(server, { ...options, input: requestInput(input) });
}

export function respondOpenAi(server: MockServer, input: unknown, options: Options = {}) {
  return expectOpenAiNonStreamingResponsesJson(server, { ...options, input: requestInput(input) });
}

export function readResponse(server: MockServer, input: unknown, options: Options = {}) {
  return expectResponses(server, { stream: false, ...options, input: requestInput(input) });
}

export function responseOpenAi(server: MockServer, input: unknown, options: Options = {}) {
  return readResponse(server, input, { model: "gpt-5.6-luna", ...options });
}

export function streamResponse(server: MockServer, input: unknown, options: Options = {}) {
  return expectResponses(server, { stream: true, ...options, input: requestInput(input) });
}

export function streamOpenAi(server: MockServer, input: unknown, options: Options = {}) {
  return streamResponse(server, input, { model: "gpt-5.6-luna", ...options });
}

export async function streamText(server: MockServer, input: unknown, options: Options = {}) {
  return (await streamResponse(server, input, options)).text();
}

export function streamOpenAiText(server: MockServer, input: unknown, options: Options = {}) {
  return streamText(server, input, { model: "gpt-5.6-luna", ...options });
}

export function postPlain(server: MockServer, input: unknown, options: Options = {}) {
  return postResponses(server, { stream: false, ...options, input: requestInput(input) });
}

export function postStream(server: MockServer, input: unknown, options: Options = {}) {
  return postResponses(server, { stream: true, ...options, input: requestInput(input) });
}

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
  expect(
    events
      .filter(
        (event) =>
          event.type === "response.output_item.added" || event.type === "response.output_item.done",
      )
      .map((event) => [
        event.type,
        requireRecord(event.item, "output item").id,
        event.output_index,
      ]),
  ).toEqual(
    ids.flatMap((id, index) => [
      ["response.output_item.added", id, index],
      ["response.output_item.done", id, index],
    ]),
  );
}
