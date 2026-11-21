import { expect, it } from "vitest";
import { definedRoles, roleOptions } from "./people-roles.js";
import type { Role } from "./types.js";

it("shows config-valid but protocol-invalid roles as unavailable, never as the default", () => {
  const roles: Role[] = ["Research Team", "a".repeat(65), "viewer"].map((name) => ({
    name,
    defined: true,
    sessions: "view",
    requiresSandbox: false,
    admin: false,
  }));
  expect(definedRoles(roles).map((role) => role.name)).toEqual(["viewer"]);
  const options = roleOptions(roles, "en-US");
  expect(options).toHaveLength(3);
  expect(options.filter((option) => option.disabled).map((option) => option.value)).toEqual([
    "Research Team",
    "a".repeat(65),
  ]);
  expect(options[0]?.description).toContain("1–64 lowercase letters");
  expect(
    roleOptions(
      [
        {
          name: "operator",
          defined: true,
          sessions: "write",
          requiresSandbox: false,
          admin: false,
        },
      ],
      "en-US",
    )[0]?.description,
  ).toBe(
    "Read and change other people's sessions · Sandbox follows agent settings · No administrator access",
  );
});

it.each([
  ["read", "Read"],
  ["suggest", "Suggest"],
  ["send", "Send"],
] as const)(
  "describes the %s invitation ceiling without changing other role details",
  (maxInvitedAccess, label) => {
    const role: Role = {
      name: "guest",
      defined: true,
      sessions: "none",
      maxInvitedAccess,
      requiresSandbox: true,
      admin: false,
    };
    expect(roleOptions([role], "en-US")[0]?.description).toBe(
      `Only sessions they’re invited to · Can be invited up to ${label}${maxInvitedAccess === "send" ? " · Participant permission: Workspace" : ""} · Sandbox required for their own sessions · No administrator access`,
    );
  },
);
