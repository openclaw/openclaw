import { describe, expect, it } from "vitest";
import {
  validateSessionsGroupsCreateParams,
  validateSessionsGroupsDefaultsResult,
  validateSessionsGroupsListResult,
  validateSessionsGroupsMutationResult,
  validateSessionsGroupsUpdateParams,
  validateSessionsGroupsUpdateResult,
} from "./index.js";

describe("session group validators", () => {
  it("accepts only a closed nonblank session-group creation name", () => {
    for (const name of ["Client", " Client ", "x".repeat(512)]) {
      expect(validateSessionsGroupsCreateParams({ name })).toBe(true);
    }
    for (const params of [
      {},
      { name: "" },
      { name: " \t\n\u00a0" },
      { name: "x".repeat(513) },
      { name: 123 },
      { name: "Client", names: ["Other"] },
      { name: "Client", sectionOrder: [] },
      { name: "Client", cwd: "/repos/client" },
    ]) {
      expect(validateSessionsGroupsCreateParams(params)).toBe(false);
    }
  });

  it("accepts legacy gateway payloads without sectionOrder", () => {
    expect(validateSessionsGroupsListResult({ groups: [] })).toBe(true);
    expect(validateSessionsGroupsMutationResult({ ok: true, groups: [] })).toBe(true);
  });

  it("accepts group defaults", () => {
    expect(validateSessionsGroupsListResult({ groups: [{ name: "Client", position: 0 }] })).toBe(
      true,
    );
    expect(
      validateSessionsGroupsListResult({
        groups: [{ name: "Client", position: 0, cwd: "/repos/client" }],
      }),
    ).toBe(false);
    expect(
      validateSessionsGroupsDefaultsResult({
        defaults: [{ name: "Client", cwd: "/repos/client", worktree: true }],
      }),
    ).toBe(true);
    expect(
      validateSessionsGroupsUpdateResult({
        ok: true,
        defaults: [{ name: "Client", cwd: "/repos/client", worktree: true }],
      }),
    ).toBe(true);
    expect(validateSessionsGroupsUpdateParams({ name: "Client", cwd: null, worktree: false })).toBe(
      true,
    );
  });
});
