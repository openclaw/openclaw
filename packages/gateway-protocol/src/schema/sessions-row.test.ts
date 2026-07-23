import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionRowSchema } from "./sessions-row.js";

describe("SessionRowSchema", () => {
  it("round-trips optional sharing fields", () => {
    const row = {
      key: "agent:main:main",
      kind: "global",
      createdActor: { type: "human", id: "profile-ada", label: "Ada" },
      archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
      visibility: "suggest",
      sharingRole: "owner",
    };
    const roundTripped = structuredClone(row);

    expect(Value.Check(SessionRowSchema, roundTripped)).toBe(true);
    expect(roundTripped).toMatchObject({
      archivedBy: { type: "human", id: "profile-bob", label: "Bob" },
      visibility: "suggest",
      sharingRole: "owner",
    });
  });
});
