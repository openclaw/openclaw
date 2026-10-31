import {
  normalizeStringEntries as normalizeAllowList,
  normalizeStringEntriesLower as normalizeAllowListLower,
} from "openclaw/plugin-sdk/string-normalization-runtime";
import { describe, expect, it } from "vitest";
import {
  normalizeSlackSlug,
  resolveSlackAllowListMatch,
  resolveSlackUserAllowListForTeam,
  resolveSlackUserAllowed,
} from "./allow-list.js";

describe("slack/allow-list", () => {
  it("normalizes lists and slugs", () => {
    expect(normalizeAllowList(["  Alice  ", 7, "", "  "])).toEqual(["Alice", "7"]);
    expect(normalizeAllowListLower(["  Alice  ", 7])).toEqual(["alice", "7"]);
    expect(normalizeSlackSlug(" Team Space  ")).toBe("team-space");
    expect(normalizeSlackSlug(" #Ops.Room ")).toBe("#ops.room");
  });

  it("matches wildcard and id candidates by default", () => {
    const match = (allowList: string[], id = "u1", allowNameMatching?: boolean) =>
      resolveSlackAllowListMatch({ allowList, id, name: "alice", allowNameMatching });
    expect(match(["*"])).toEqual({
      allowed: true,
      matchKey: "*",
      matchSource: "wildcard",
    });

    expect(match(["u1"])).toEqual({
      allowed: true,
      matchKey: "u1",
      matchSource: "id",
    });

    expect(match(["slack:alice"], "u2")).toEqual({ allowed: false });
    expect(match(["slack:alice"], "u2", true)).toEqual({
      allowed: true,
      matchKey: "slack:alice",
      matchSource: "prefixed-name",
    });
  });

  it("allows all users when allowList is empty and denies unknown entries", () => {
    expect(resolveSlackUserAllowed({ allowList: [], userId: "u1", userName: "alice" })).toBe(true);
    expect(resolveSlackUserAllowed({ allowList: ["u2"], userId: "u1", userName: "alice" })).toBe(
      false,
    );
  });

  it("matches a workspace-qualified user only in that workspace", () => {
    const allowList = ["team:t11111111:user:u01234567"];
    const match = (teamId: string, entries = allowList) =>
      resolveSlackAllowListMatch({ allowList: entries, teamId, id: "U01234567" });
    expect(match("T11111111")).toEqual({
      allowed: true,
      matchKey: "team:t11111111:user:u01234567",
      matchSource: "workspace-id",
    });
    expect(match("T22222222")).toEqual({ allowed: false });
    expect(match("T22222222", ["u01234567"])).toEqual({
      allowed: true,
      matchKey: "u01234567",
      matchSource: "id",
    });
  });

  it("preserves org-wide IDs and workspace-qualified user identities", () => {
    expect(
      resolveSlackUserAllowListForTeam({
        allowList: ["W01234567", "team:T11111111:user:U01234567", "team:T22222222:user:U01234567"],
        teamId: "T11111111",
      }),
    ).toEqual(["w01234567", "team:t11111111:user:u01234567"]);
  });
});
