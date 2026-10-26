import { describe, expect, it } from "vitest";
import {
  buildRuntimeConfigOptionPairs,
  mergeRuntimeOptions,
  validateRuntimeOptionPatch,
} from "./runtime-options.js";

describe("validateRuntimeOptionPatch", () => {
  const emptyMessages = {
    runtimeMode: "Runtime mode must not be empty.",
    model: "Model id must not be empty.",
    thinking: "Thinking level must not be empty.",
    cwd: "Working directory must not be empty.",
    permissionProfile: "Permission profile must not be empty.",
    timeoutSeconds: "Timeout must be a positive integer in seconds.",
  };

  it("normalizes cwd without changing the input", () => {
    const patch = Object.freeze({ cwd: " /workspace/project " });
    expect(validateRuntimeOptionPatch(patch)).toStrictEqual({ cwd: "/workspace/project" });
    expect(patch).toStrictEqual({ cwd: " /workspace/project " });
  });

  it.each([
    ["thinking", "x".repeat(33), "Thinking level must be at most 32 characters."],
    [
      "cwd",
      "relative/project",
      'Working directory must be an absolute path. Received "relative/project".',
    ],
  ])("preserves the %s validation error", (key, invalid, message) => {
    expect(() => validateRuntimeOptionPatch({ [key]: invalid })).toThrow(
      expect.objectContaining({ code: "ACP_INVALID_RUNTIME_OPTION", message }),
    );
  });

  it("distinguishes omitted, inherited and own undefined timeoutSeconds", () => {
    expect(validateRuntimeOptionPatch({})).toStrictEqual({});
    expect(validateRuntimeOptionPatch(Object.create({ timeoutSeconds: 60.6 }))).toStrictEqual({});
    expect(validateRuntimeOptionPatch({ timeoutSeconds: undefined })).toStrictEqual({
      timeoutSeconds: undefined,
    });
  });

  it("rejects unknown keys before validating scalar values", () => {
    const patch = { runtimeMode: "", unknown: true };
    expect(() => validateRuntimeOptionPatch(patch)).toThrow('Unknown runtime option "unknown".');
  });

  it("validates scalars in their fixed order before backend extras", () => {
    const patch: Record<string, unknown> = {
      backendExtras: [],
      ...Object.fromEntries(
        Object.keys(emptyMessages)
          .toReversed()
          .map((key) => [key, null]),
      ),
    };
    for (const [key, emptyMessage] of Object.entries(emptyMessages)) {
      expect(() => validateRuntimeOptionPatch(patch)).toThrow(emptyMessage);
      delete patch[key];
    }
    expect(() => validateRuntimeOptionPatch(patch)).toThrow(
      "Backend extras must be a key/value object.",
    );
  });

  it("rounds timeout before checking its bounds", () => {
    expect(validateRuntimeOptionPatch({ timeoutSeconds: 86_400.49 })).toEqual({
      timeoutSeconds: 86_400,
    });
  });

  it("rejects timeout outside the rounded bounds", () => {
    expect(() => validateRuntimeOptionPatch({ timeoutSeconds: 86_400.5 })).toThrow(
      "Timeout must be between 1 and 86400 seconds.",
    );
  });
});

it.each([
  ["clears", undefined, undefined],
  ["merges", { profile: "work" }, { provider: "anthropic", profile: "work" }],
] as const)("%s backend extras without changing the model", (_action, backendExtras, expected) => {
  const model = "claude-sonnet-4.6";
  expect(
    mergeRuntimeOptions({
      current: { model, backendExtras: { provider: "anthropic" } },
      patch: { backendExtras },
    }),
  ).toEqual(expected ? { model, backendExtras: expected } : { model });
});

describe("buildRuntimeConfigOptionPairs timeout advertisement", () => {
  it("keeps the timeout pair when advertised keys are unknown (empty or undefined)", () => {
    expect(buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 })).toEqual([["timeout", "60"]]);
    expect(buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, [])).toEqual([["timeout", "60"]]);
  });

  it("does not affect model or thinking emission when only timeout is unadvertised", () => {
    const pairs = buildRuntimeConfigOptionPairs(
      { model: "claude-sonnet-4.6", thinking: "high", timeoutSeconds: 60 },
      ["model", "thinking"],
    );
    expect(pairs).toEqual([
      ["model", "claude-sonnet-4.6"],
      ["thinking", "high"],
    ]);
  });
});
