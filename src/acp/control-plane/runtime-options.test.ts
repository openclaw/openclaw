/** Tests runtime config-option serialization against advertised backend keys. */
import { describe, expect, it } from "vitest";
import type { AcpSessionRuntimeOptions } from "../../config/sessions/types.js";
import {
  buildRuntimeConfigOptionPairs,
  mergeRuntimeOptions,
  validateRuntimeOptionPatch,
} from "./runtime-options.js";

describe("validateRuntimeOptionPatch", () => {
  const scalarCases = [
    {
      key: "runtimeMode",
      input: " plan ",
      expected: "plan",
      invalid: "x".repeat(65),
      message: "Runtime mode must be at most 64 characters.",
      emptyMessage: "Runtime mode must not be empty.",
    },
    {
      key: "model",
      input: " openai/example-model ",
      expected: "openai/example-model",
      invalid: "x".repeat(201),
      message: "Model id must be at most 200 characters.",
      emptyMessage: "Model id must not be empty.",
    },
    {
      key: "thinking",
      input: " high ",
      expected: "high",
      invalid: "x".repeat(33),
      message: "Thinking level must be at most 32 characters.",
      emptyMessage: "Thinking level must not be empty.",
    },
    {
      key: "cwd",
      input: " /workspace/project ",
      expected: "/workspace/project",
      invalid: "relative/project",
      message: 'Working directory must be an absolute path. Received "relative/project".',
      emptyMessage: "Working directory must not be empty.",
    },
    {
      key: "permissionProfile",
      input: " strict ",
      expected: "strict",
      invalid: "x".repeat(81),
      message: "Permission profile must be at most 80 characters.",
      emptyMessage: "Permission profile must not be empty.",
    },
    {
      key: "timeoutSeconds",
      input: 60.6,
      expected: 61,
      invalid: Number.NaN,
      message: "Timeout must be a positive integer in seconds.",
      emptyMessage: "Timeout must be a positive integer in seconds.",
    },
  ] as const;

  it.each(scalarCases)("normalizes $key without changing the input", ({ key, input, expected }) => {
    const patch = Object.freeze({ [key]: input });
    expect(validateRuntimeOptionPatch(patch)).toStrictEqual({ [key]: expected });
    expect(patch).toStrictEqual({ [key]: input });
  });

  it.each(scalarCases)("preserves the $key validation error", ({ key, invalid, message }) => {
    expect(() => validateRuntimeOptionPatch({ [key]: invalid })).toThrow(
      expect.objectContaining({ code: "ACP_INVALID_RUNTIME_OPTION", message }),
    );
  });

  it.each(scalarCases)(
    "distinguishes omitted, inherited and own undefined $key",
    ({ key, input }) => {
      expect(validateRuntimeOptionPatch({})).toStrictEqual({});
      expect(validateRuntimeOptionPatch(Object.create({ [key]: input }))).toStrictEqual({});
      const cleared = validateRuntimeOptionPatch({ [key]: undefined });
      expect(Object.hasOwn(cleared, key)).toBe(true);
      expect(cleared).toStrictEqual({ [key]: undefined });
    },
  );

  it("rejects unknown keys before validating scalar values", () => {
    const patch = { runtimeMode: "", unknown: true } as Partial<AcpSessionRuntimeOptions>;
    expect(() => validateRuntimeOptionPatch(patch)).toThrow('Unknown runtime option "unknown".');
  });

  it("validates scalars in their fixed order before backend extras", () => {
    const patch: Record<string, unknown> = {
      backendExtras: [],
      ...Object.fromEntries(scalarCases.toReversed().map(({ key }) => [key, null])),
    };
    for (const { key, emptyMessage } of scalarCases) {
      expect(() => validateRuntimeOptionPatch(patch)).toThrow(emptyMessage);
      delete patch[key];
    }
    expect(() => validateRuntimeOptionPatch(patch)).toThrow(
      "Backend extras must be a key/value object.",
    );
  });

  it.each([
    [0.5, 1],
    [1.49, 1],
    [1.5, 2],
    [86_400.49, 86_400],
  ])("rounds timeout %s to %s before checking its bounds", (input, expected) => {
    expect(validateRuntimeOptionPatch({ timeoutSeconds: input })).toEqual({
      timeoutSeconds: expected,
    });
  });

  it.each([0.49, 86_400.5])("rejects timeout %s outside the rounded bounds", (timeoutSeconds) => {
    expect(() => validateRuntimeOptionPatch({ timeoutSeconds })).toThrow(
      "Timeout must be between 1 and 86400 seconds.",
    );
  });
});

describe("mergeRuntimeOptions", () => {
  it("clears top-level options when a patch explicitly sets them to undefined", () => {
    const patch = {
      runtimeMode: undefined,
      model: undefined,
      thinking: undefined,
      cwd: undefined,
      permissionProfile: undefined,
      timeoutSeconds: undefined,
    } as Partial<AcpSessionRuntimeOptions>;

    expect(
      mergeRuntimeOptions({
        current: {
          runtimeMode: "plan",
          model: "claude-sonnet-4.6",
          thinking: "high",
          cwd: "/tmp/project",
          permissionProfile: "trusted",
          timeoutSeconds: 120,
        },
        patch,
      }),
    ).toEqual({});
  });

  it("clears backend extras when a patch explicitly clears them", () => {
    expect(
      mergeRuntimeOptions({
        current: {
          model: "claude-sonnet-4.6",
          backendExtras: { provider: "anthropic", profile: "work" },
        },
        patch: { backendExtras: undefined } as Partial<AcpSessionRuntimeOptions>,
      }),
    ).toEqual({ model: "claude-sonnet-4.6" });
  });

  it("keeps merging backend extras when a patch provides new entries", () => {
    expect(
      mergeRuntimeOptions({
        current: { backendExtras: { provider: "anthropic" } },
        patch: { backendExtras: { profile: "work" } },
      }),
    ).toEqual({ backendExtras: { provider: "anthropic", profile: "work" } });
  });
});

describe("buildRuntimeConfigOptionPairs timeout advertisement", () => {
  it("omits the timeout pair when advertised keys exclude every timeout alias", () => {
    const pairs = buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, [
      "model",
      "thinking",
      "approval_policy",
    ]);
    expect(pairs).toEqual([]);
  });

  it("keeps the timeout pair when advertised keys include `timeout`", () => {
    const pairs = buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, ["model", "timeout"]);
    expect(pairs).toEqual([["timeout", "60"]]);
  });

  it("keeps the timeout pair using the advertised `timeout_seconds` alias", () => {
    const pairs = buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, [
      "model",
      "timeout_seconds",
    ]);
    expect(pairs).toEqual([["timeout_seconds", "60"]]);
  });

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

describe("buildRuntimeConfigOptionPairs thinking advertisement", () => {
  it("omits automatic thinking when the backend advertises no thinking alias", () => {
    expect(buildRuntimeConfigOptionPairs({ thinking: "high" }, ["mode", "model"])).toEqual([]);
  });

  it("maps automatic thinking to the advertised reasoning_effort alias", () => {
    expect(
      buildRuntimeConfigOptionPairs({ thinking: "high" }, ["model", "reasoning_effort"]),
    ).toEqual([["reasoning_effort", "high"]]);
  });

  it("keeps automatic thinking when advertised keys are unknown", () => {
    expect(buildRuntimeConfigOptionPairs({ thinking: "high" })).toEqual([["thinking", "high"]]);
  });
});
