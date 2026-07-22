import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionRowSchema } from "./sessions-row.js";

describe("SessionRowSchema", () => {
  it("round-trips optional sharing fields", () => {
    const row = {
      key: "agent:main:main",
      kind: "global",
      createdActor: { type: "human", id: "profile-ada", label: "Ada" },
      visibility: "suggest",
      sharingRole: "owner",
    };
    const roundTripped = JSON.parse(JSON.stringify(row)) as typeof row;

    expect(Value.Check(SessionRowSchema, roundTripped)).toBe(true);
    expect(roundTripped).toMatchObject({ visibility: "suggest", sharingRole: "owner" });
  });
});
