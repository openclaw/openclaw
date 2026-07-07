import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  SessionsCreateResultSchema,
  validateSessionsCreateParams,
  validateWorktreesCreateParams,
  validateWorktreesGcParams,
  validateWorktreesRemoveParams,
} from "../index.js";

describe("managed worktree protocol schemas", () => {
  it("accepts the additive worktree method payloads", () => {
    expect(
      validateWorktreesCreateParams({ repoRoot: "/repo", name: "task-one", baseRef: "main" }),
    ).toBe(true);
    expect(validateWorktreesRemoveParams({ id: "id", force: true })).toBe(true);
    expect(validateWorktreesGcParams({})).toBe(true);
    expect(validateSessionsCreateParams({ agentId: "main", worktree: true })).toBe(true);
    expect(
      Value.Check(SessionsCreateResultSchema, {
        ok: true,
        key: "agent:main:dashboard:test",
        worktree: { id: "id", path: "/worktree", branch: "openclaw/wt-test" },
      }),
    ).toBe(true);
  });

  it("rejects invalid names and unknown fields", () => {
    expect(validateWorktreesCreateParams({ repoRoot: "/repo", name: "Bad Name" })).toBe(false);
    expect(validateWorktreesGcParams({ unexpected: true })).toBe(false);
  });
});
