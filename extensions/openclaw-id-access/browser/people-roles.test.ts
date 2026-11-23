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
});
