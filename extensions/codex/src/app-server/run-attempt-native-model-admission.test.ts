import { expect, it, vi } from "vitest";
import { resolveCodexNativeModelAdmission } from "./run-attempt-native-model-admission.js";

it.each([
  { native: false, source: true, required: true, hooks: true, expected: undefined },
  { native: true, source: false, required: true, hooks: true, expected: undefined },
  { native: true, source: true, required: true, hooks: true, expected: "required" },
  { native: true, source: true, required: true, hooks: false, expected: "required" },
  { native: true, source: true, required: false, hooks: true, expected: "optional" },
  { native: true, source: true, required: false, hooks: false, expected: "disabled" },
])("selects native model admission without retaining extra authority: $expected", (row) => {
  const release = vi.fn();
  const signal = new AbortController().signal;
  const assertCurrent = () => signal.throwIfAborted();
  const retainSourceAuthority = vi.fn(() => ({
    signal,
    modelPolicyRequired: row.required,
    bindModelExecution: () => ({ signal, assertCurrent, release: () => {} }),
    assertCurrent,
    release,
  }));
  expect(
    resolveCodexNativeModelAdmission(
      row.native,
      row.source ? { retainSourceAuthority } : {},
      row.hooks,
    ),
  ).toBe(row.expected);
  expect(retainSourceAuthority).toHaveBeenCalledTimes(row.native && row.source ? 1 : 0);
  expect(release).toHaveBeenCalledTimes(row.native && row.source ? 1 : 0);
});

it.each([true, false])("keeps private hook admission without a source grant: hooks=%s", (hooks) => {
  const retainSourceAuthority = vi.fn(() => undefined);
  expect(resolveCodexNativeModelAdmission(true, { retainSourceAuthority }, hooks)).toBe(
    hooks ? "optional" : "disabled",
  );
  expect(retainSourceAuthority).toHaveBeenCalledOnce();
});
