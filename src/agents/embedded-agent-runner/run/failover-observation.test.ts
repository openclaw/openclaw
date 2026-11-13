import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { log } from "../logger.js";
import { createFailoverDecisionLogger } from "./failover-observation.js";

type DecisionBase = Parameters<typeof createFailoverDecisionLogger>[0];
const base: DecisionBase = {
  stage: "assistant",
  runId: "run:base",
  failoverReason: null,
  provider: "openai",
  model: "mock-1",
  profileId: "openai:p1",
  fallbackConfigured: false,
};
const warn = vi.fn<typeof log.warn>();
beforeEach(() => {
  warn.mockClear();
  vi.spyOn(log, "warn").mockImplementation(warn);
});

function observeDecision(
  overrides: Partial<DecisionBase> = {},
  decision: Parameters<ReturnType<typeof createFailoverDecisionLogger>>[0] = "surface_error",
  extra?: Parameters<ReturnType<typeof createFailoverDecisionLogger>>[1],
) {
  createFailoverDecisionLogger({ ...base, ...overrides })(decision, extra);
  return expectDefined(warn.mock.calls[0]?.[1], "structured failover details");
}

afterEach(() => vi.restoreAllMocks());

type ObservationCase = {
  input: Partial<DecisionBase>;
  decision: Parameters<typeof observeDecision>[1];
  extra: Parameters<typeof observeDecision>[2];
  fields: Record<string, unknown>;
  console: string[];
};
it.each`
  name                   | input                                                                                                                                                                | decision              | extra                | fields                                                                                                                                                                                          | console
  ${"timeout fallback"}  | ${{ timedOut: true }}                                                                                                                                                | ${"surface_error"}    | ${undefined}         | ${{ failoverReason: "timeout", profileFailureReason: "timeout", timedOut: true }}                                                                                                               | ${[]}
  ${"explicit reason"}   | ${{ rawError: '{"error":{"type":"overloaded_error"}}', failoverReason: "overloaded", profileFailureReason: "overloaded", fallbackConfigured: true, timedOut: true }} | ${"surface_error"}    | ${undefined}         | ${{ failoverReason: "overloaded", profileFailureReason: "overloaded", timedOut: true }}                                                                                                         | ${[]}
  ${"retry override"}    | ${{ failoverReason: "overloaded", retryCount: 3, profileRotationCount: 2 }}                                                                                          | ${"retry_same_model"} | ${{ retryCount: 1 }} | ${{ decision: "retry_same_model", retryCount: 1, profileRotationCount: 2 }}                                                                                                                     | ${["retry=1 rotations=2 "]}
  ${"source and target"} | ${{ model: "gpt-5.4", sourceProvider: "github-copilot", sourceModel: "gpt-5.4-mini", attemptCount: 4, retryCount: 2, profileRotationCount: 1 }}                      | ${"fallback_model"}   | ${undefined}         | ${{ decision: "fallback_model", attemptCount: 4, retryCount: 2, profileRotationCount: 1, sourceProvider: "github-copilot", sourceModel: "gpt-5.4-mini", provider: "openai", model: "gpt-5.4" }} | ${["from=github-copilot/gpt-5.4-mini", "to=openai/gpt-5.4"]}
`(
  "records $name in failover diagnostics",
  ({ input, decision, extra, fields, console }: ObservationCase) => {
    const observation = observeDecision(input, decision, extra);
    expect(observation).toMatchObject(fields);
    for (const text of console) {
      expect(observation.consoleMessage).toContain(text);
    }
  },
);
it("omits normal continuation logs when debug is disabled", () => {
  vi.spyOn(log, "isEnabled").mockReturnValue(false);
  const debugSpy = vi.spyOn(log, "debug").mockImplementation(() => {});

  createFailoverDecisionLogger(base)("continue_normal");

  expect(warn).not.toHaveBeenCalled();
  expect(debugSpy).not.toHaveBeenCalled();
});

it.each([
  ["401 <!DOCTYPE html><html><body>Unauthorized</body></html>", "auth_html"],
  ["403 <html>Enable JavaScript and cookies to continue.</html>", "upstream_html"],
])("keeps %s bodies out of both diagnostic sinks", (rawError, kind) => {
  const observation = observeDecision(
    {
      rawError,
      failoverReason: "auth",
      profileFailureReason: "auth",
    },
    "rotate_profile",
  );
  expect(observation.providerRuntimeFailureKind).toBe(kind);
  expect(observation).not.toHaveProperty("rawErrorPreview");
  expect(JSON.stringify(observation)).not.toContain("<html>");
  expect(observation.consoleMessage).not.toContain("rawError=");
});
