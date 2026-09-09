import { describe, expect, it } from "vitest";
import {
  validateSessionsGroupsDefaultsParams,
  validateSessionsGroupsDefaultsResult,
  validateSessionsGroupsDeleteParams,
  validateSessionsGroupsListParams,
  validateSessionsGroupsListResult,
  validateSessionsGroupsMutationResult,
  validateSessionsGroupsPutParams,
  validateSessionsGroupsRenameParams,
  validateSessionsGroupsUpdateParams,
  validateSessionsGroupsUpdateResult,
} from "./index.js";

describe("session group validators", () => {
  it.each([
    { method: "list", validate: validateSessionsGroupsListParams, params: {} },
    { method: "defaults", validate: validateSessionsGroupsDefaultsParams, params: {} },
    { method: "put", validate: validateSessionsGroupsPutParams, params: { names: ["Work"] } },
    {
      method: "rename",
      validate: validateSessionsGroupsRenameParams,
      params: { name: "Work", to: "Next" },
    },
    { method: "delete", validate: validateSessionsGroupsDeleteParams, params: { name: "Work" } },
    {
      method: "update",
      validate: validateSessionsGroupsUpdateParams,
      params: { name: "Work", cwd: null, worktree: false },
    },
  ])(
    "accepts additive agentId for $method without widening the wire schema",
    ({ validate, params }) => {
      expect(validate(params)).toBe(true);
      expect(validate({ ...params, agentId: "research" })).toBe(true);
      expect(validate({ ...params, agentId: "" })).toBe(false);
      expect(validate({ ...params, agentId: 42 })).toBe(false);
      expect(validate({ ...params, agentID: "research" })).toBe(false);
    },
  );

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
