import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
// Payload test helpers provide stable defaults and assertion helpers for the
// embedded run reply payload builder.
import { expect } from "vitest";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";

type BuildPayloadParams = Parameters<typeof buildEmbeddedRunPayloads>[0];
type RunPayloads = ReturnType<typeof buildEmbeddedRunPayloads>;

export function makePayloadAssistant(overrides: Partial<AssistantMessage>): AssistantMessage {
  const errorJson =
    '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CX7DwS7tSvggaNHmefwWg"}';
  return makeAssistantMessageFixture({
    errorMessage: errorJson,
    content: [{ type: "text", text: errorJson }],
    ...overrides,
  });
}

export function buildPayloads(overrides: Partial<BuildPayloadParams> = {}) {
  // Defaults mirror a quiet interactive session so tests opt into cron,
  // verbose, tool-result, or current-assistant behavior explicitly.
  return buildEmbeddedRunPayloads({
    assistantTexts: [],
    lastAssistant: undefined,
    currentAssistant:
      overrides.currentAssistant === undefined
        ? overrides.lastAssistant
        : overrides.currentAssistant,
    isCronTrigger: false,
    sessionKey: "session:telegram",
    verboseLevel: "off",
    reasoningLevel: "off",
    toolResultFormat: "plain",
    ...overrides,
  });
}

export function expectSinglePayloadText(
  payloads: RunPayloads,
  text: string,
  expectedError?: boolean,
): void {
  expect(payloads).toHaveLength(1);
  expect(payloads[0]?.text).toBe(text);
  if (typeof expectedError === "boolean") {
    expect(payloads[0]?.isError).toBe(expectedError);
  }
}

export function expectSingleToolErrorPayload(
  payloads: RunPayloads,
  params: { title: string; detail?: string; absentDetail?: string },
): void {
  // Tool error payloads intentionally omit raw details unless the case opts in;
  // absentDetail catches accidental leakage in compact modes.
  expect(payloads).toHaveLength(1);
  expect(payloads[0]?.isError).toBe(true);
  expect(payloads[0]?.text).toContain(params.title);
  if (typeof params.detail === "string") {
    expect(payloads[0]?.text).toContain(params.detail);
  }
  if (typeof params.absentDetail === "string") {
    expect(payloads[0]?.text).not.toContain(params.absentDetail);
  }
}
