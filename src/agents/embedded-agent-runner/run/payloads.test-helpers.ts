import { expect } from "vitest";
import { buildEmbeddedRunPayloads } from "./payloads.js";

/** Parameter shape shared by payload tests and the production payload builder. */
export type BuildPayloadParams = Parameters<typeof buildEmbeddedRunPayloads>[0];
type RunPayloads = ReturnType<typeof buildEmbeddedRunPayloads>;

/** Builds embedded-run payloads for tests with stable defaults. */
export function buildPayloads(overrides: Partial<BuildPayloadParams> = {}) {
  return buildEmbeddedRunPayloads({
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    currentAssistant:
      overrides.currentAssistant === undefined
        ? overrides.lastAssistant
        : overrides.currentAssistant,
    isCronTrigger: false,
    sessionKey: "session:telegram",
    inlineToolResultsAllowed: false,
    verboseLevel: "off",
    reasoningLevel: "off",
    toolResultFormat: "plain",
    ...overrides,
  });
}

/** Asserts a single text payload with optional error-state verification. */
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

/** Asserts the standard single tool-error payload shape used by payload tests. */
export function expectSingleToolErrorPayload(
  payloads: RunPayloads,
  params: { title: string; detail?: string; absentDetail?: string },
): void {
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
