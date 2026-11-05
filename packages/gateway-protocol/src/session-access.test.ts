import { expect, it } from "vitest";
import { validateSessionsCreateParams, validateSessionsPatchParams } from "./index.js";

it("admits confidential access controls through generated create/patch validators", () => {
  for (const access of [
    { mode: "creator" },
    { mode: "source" },
    { mode: "unrestricted" },
    { mode: "audience", profileIds: ["selected-profile"] },
  ]) {
    expect(validateSessionsCreateParams({ agentId: "main", access })).toBe(true);
    expect(
      validateSessionsPatchParams({
        key: "agent:main:dashboard:fixture",
        expectedSessionId: "current",
        access,
      }),
    ).toBe(true);
  }
});

it("rejects malformed or implicit confidential audiences at the wire boundary", () => {
  for (const access of [
    { mode: "audience" },
    { mode: "audience", profileIds: [""] },
    { mode: "audience", profileIds: ["same", "same"] },
    { mode: "creator", profileIds: ["not-allowed"] },
    { mode: "everyone" },
  ]) {
    expect(
      validateSessionsPatchParams({
        key: "agent:main:dashboard:fixture",
        expectedSessionId: "current",
        access,
      }),
    ).toBe(false);
  }
});
