import { expect, it } from "vitest";
import {
  buildRuntimeConfigOptionPairs,
  mergeRuntimeOptions,
  validateRuntimeOptionPatch,
} from "./runtime-options.js";

it("normalizes cwd without changing the input", () => {
  const patch = Object.freeze({ cwd: " /workspace/project " });
  expect(validateRuntimeOptionPatch(patch)).toStrictEqual({ cwd: "/workspace/project" });
});

it.each<Record<string, unknown>>([
  { thinking: "x".repeat(33) },
  { cwd: "relative/project" },
  { unknown: true },
  { backendExtras: [] },
  { timeoutSeconds: null },
  { timeoutSeconds: 86_400.5 },
  ...["runtimeMode", "model", "thinking", "cwd", "permissionProfile"].map((key) => ({
    [key]: null,
  })),
])("rejects invalid runtime options: %j", (patch) => {
  expect(() => validateRuntimeOptionPatch(patch)).toThrow(
    expect.objectContaining({ code: "ACP_INVALID_RUNTIME_OPTION" }),
  );
});

it("distinguishes omitted, inherited and own undefined timeoutSeconds", () => {
  expect(validateRuntimeOptionPatch({})).toStrictEqual({});
  expect(validateRuntimeOptionPatch(Object.create({ timeoutSeconds: 60.6 }))).toStrictEqual({});
  expect(validateRuntimeOptionPatch({ timeoutSeconds: undefined })).toStrictEqual({
    timeoutSeconds: undefined,
  });
});

it("rounds timeout before checking its bounds", () => {
  expect(validateRuntimeOptionPatch({ timeoutSeconds: 86_400.49 })).toEqual({
    timeoutSeconds: 86_400,
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

it.each([undefined, []])("keeps timeout when advertised keys are unknown: %j", (keys) => {
  expect(buildRuntimeConfigOptionPairs({ timeoutSeconds: 60 }, keys)).toEqual([["timeout", "60"]]);
});

it("emits model and thinking but omits unadvertised timeout", () => {
  expect(
    buildRuntimeConfigOptionPairs(
      { model: "claude-sonnet-4.6", thinking: "high", timeoutSeconds: 60 },
      ["model", "thinking"],
    ),
  ).toEqual([
    ["model", "claude-sonnet-4.6"],
    ["thinking", "high"],
  ]);
});
