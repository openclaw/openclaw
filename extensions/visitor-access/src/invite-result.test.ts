import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { resolveVisitorSignInUrl } from "./invite-result.js";
import { createVisitorTools } from "./tools.js";

describe("visitor invitation surface", () => {
  it.each([
    [{ publicOrigin: "https://team.example.com" }, "https://team.example.com"],
    [
      { publicOrigin: "https://team.example.com", controlUi: { basePath: "team/" } },
      "https://team.example.com/team/",
    ],
    [{ publicOrigin: "https://team.example.com", controlUi: { enabled: false } }, undefined],
    [{ publicOrigin: "https://team.example.com/path" }, undefined],
    [{}, undefined],
  ])("resolves the sign-in URL from trusted Gateway config: %j", (gateway, expected) => {
    expect(resolveVisitorSignInUrl({ gateway })).toBe(expected);
  });

  it("accepts an optional visitor_invite note of at most 1000 characters", () => {
    const invite = createVisitorTools({
      senderIsOwner: true,
      assertInvocationCurrent() {},
    }).find((tool) => tool.name === "visitor_invite")!;
    const note = "n".repeat(1000);

    expect(invite.description).toContain("note");
    expect(Value.Check(invite.parameters, { email: "visitor@example.com" })).toBe(true);
    expect(Value.Check(invite.parameters, { email: "visitor@example.com", note })).toBe(true);
    expect(Value.Check(invite.parameters, { email: "visitor@example.com", note: `${note}n` })).toBe(
      false,
    );
    expect(Value.Check(invite.parameters, { email: "visitor@example.com", note: 7 })).toBe(false);
  });
});
