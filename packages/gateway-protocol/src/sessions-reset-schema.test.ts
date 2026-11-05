import { expect, test } from "vitest";
import {
  validateSessionsForkParams,
  validateSessionsResetParams,
  validateSessionsRewindParams,
} from "./index.js";

test("sessions.rewind accepts reset undo without extending the fork contract", () => {
  const params = { sessionKey: "agent:main:main", entryId: "reset-boundary", undoReset: true };
  expect(validateSessionsRewindParams(params)).toBe(true);
  expect(validateSessionsRewindParams({ ...params, undoReset: "true" })).toBe(false);
  expect(validateSessionsForkParams(params)).toBe(false);
});

test("sessions.reset validates an expected session ID", () => {
  expect(
    validateSessionsResetParams({
      key: "agent:main:main",
      expectedSessionId: "session-before-reset",
    }),
  ).toBe(true);
  expect(validateSessionsResetParams({ key: "agent:main:main", expectedSessionId: "" })).toBe(
    false,
  );
});
