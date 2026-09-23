import { describe, expect, it } from "vitest";
import { continuityRpcError } from "./rpc-errors.js";
import { ContinuityError } from "./state-helpers.js";

describe("continuity RPC failure contract", () => {
  it.each([
    ["invalid-direction", "INVALID_REQUEST", "input", false],
    ["home-execute-denied", "FORBIDDEN", "denied", false],
    ["destination-revision-conflict", "INVALID_REQUEST", "conflict", false],
    ["service-not-running", "UNAVAILABLE", "service", true],
    ["scheduled-turn-cleanup-failed", "UNAVAILABLE", "service", false],
  ] as const)(
    "classifies %s without suggesting an unsafe retry",
    (reason, code, category, retryable) => {
      expect(continuityRpcError(new ContinuityError(reason))).toMatchObject({
        code,
        retryable,
        details: { category, reason },
      });
    },
  );

  it.each([
    ["invalid-selection", "INVALID_REQUEST", "input"],
    ["export-denied", "FORBIDDEN", "denied"],
    ["context-record-changed", "INVALID_REQUEST", "conflict"],
    ["temporary-context-changed", "INVALID_REQUEST", "conflict"],
    ["state-write-not-committed", "UNAVAILABLE", "service"],
  ] as const)("classifies known scoped-context %s", (reason, code, category) => {
    expect(continuityRpcError(new Error(`continuity-context-host:${reason}`))).toMatchObject({
      code,
      retryable: false,
      details: { category, reason },
    });
  });

  it("does not expose unknown backend diagnostics or promise retry safety", () => {
    expect(continuityRpcError(new Error("storage failed at /private/path"))).toEqual({
      code: "UNAVAILABLE",
      message: "continuity-spike-unavailable",
      retryable: false,
      details: { pluginId: "continuity-spike", category: "service" },
    });
  });
});
