import { Value } from "typebox/value";
import { expect, it } from "vitest";
import {
  SessionRowSchema,
  validateSessionsPatchParams,
  validateSessionsPatchManyParams,
} from "./index.js";

it("validates shared dashboard defaults on single/bulk patches and projected rows", () => {
  const key = "agent:main:main";
  for (const boardPresentation of ["split", "expanded", null]) {
    expect(validateSessionsPatchParams({ key, boardPresentation })).toBe(true);
    expect(
      validateSessionsPatchManyParams({ targets: [{ key }], patch: { boardPresentation } }),
    ).toBe(true);
  }
  for (const boardPresentation of ["fullscreen", "", true, 1]) {
    expect(validateSessionsPatchParams({ key, boardPresentation })).toBe(false);
    expect(
      validateSessionsPatchManyParams({ targets: [{ key }], patch: { boardPresentation } }),
    ).toBe(false);
  }
  for (const boardPresentation of ["split", "expanded"]) {
    expect(Value.Check(SessionRowSchema, { key, kind: "direct", boardPresentation })).toBe(true);
  }
  expect(Value.Check(SessionRowSchema, { key, kind: "direct", boardPresentation: null })).toBe(
    false,
  );
});
