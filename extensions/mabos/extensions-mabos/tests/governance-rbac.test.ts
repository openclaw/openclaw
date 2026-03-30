import { describe, expect, it } from "vitest";
import { RbacEngine } from "../src/governance/rbac.js";
import { PermissionDeniedError } from "../src/governance/types.js";

const testPolicy = {
  roles: {
    admin: {
      permissions: ["*"],
    },
    operator: {
      permissions: ["budget:*", "agent:*", "tool:*", "audit:read"],
      deny: ["agent:delete"],
    },
    agent: {
      permissions: ["tool:read", "tool:write", "reason:*"],
    },
    viewer: {
      permissions: ["*.read", "audit:read"],
    },
  },
};

describe("RbacEngine", () => {
  const rbac = new RbacEngine(testPolicy);

  it("admin can do anything", () => {
    expect(rbac.isAllowed("admin", "budget:write")).toBe(true);
    expect(rbac.isAllowed("admin", "agent:delete")).toBe(true);
    expect(rbac.isAllowed("admin", "some.random.action")).toBe(true);
  });

  it("operator is allowed matching permissions", () => {
    expect(rbac.isAllowed("operator", "budget:read")).toBe(true);
    expect(rbac.isAllowed("operator", "budget:write")).toBe(true);
    expect(rbac.isAllowed("operator", "agent:create")).toBe(true);
    expect(rbac.isAllowed("operator", "tool:execute")).toBe(true);
    expect(rbac.isAllowed("operator", "audit:read")).toBe(true);
  });

  it("operator denied by explicit deny rule", () => {
    expect(rbac.isAllowed("operator", "agent:delete")).toBe(false);
  });

  it("agent can read, write, and reason", () => {
    expect(rbac.isAllowed("agent", "tool:read")).toBe(true);
    expect(rbac.isAllowed("agent", "tool:write")).toBe(true);
    expect(rbac.isAllowed("agent", "reason:chain-of-thought")).toBe(true);
    expect(rbac.isAllowed("agent", "reason:reflect")).toBe(true);
  });

  it("agent denied unmatched action", () => {
    expect(rbac.isAllowed("agent", "budget:write")).toBe(false);
    expect(rbac.isAllowed("agent", "agent:delete")).toBe(false);
    expect(rbac.isAllowed("agent", "audit:read")).toBe(false);
  });

  it("viewer can only read", () => {
    expect(rbac.isAllowed("viewer", "budget.read")).toBe(true);
    expect(rbac.isAllowed("viewer", "audit:read")).toBe(true);
    expect(rbac.isAllowed("viewer", "budget:write")).toBe(false);
    expect(rbac.isAllowed("viewer", "tool:execute")).toBe(false);
  });

  it("unknown role is denied", () => {
    expect(rbac.isAllowed("guest", "anything")).toBe(false);

    expect(() => rbac.assertAllowed("guest", "anything")).toThrow(PermissionDeniedError);
  });
});
