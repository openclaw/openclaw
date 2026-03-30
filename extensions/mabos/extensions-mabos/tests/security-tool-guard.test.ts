import { describe, it, assert } from "vitest";
import { ToolGuard } from "../src/security/tool-guard.js";

describe("ToolGuard", () => {
  const guard = new ToolGuard({
    dangerousTools: ["execute_command", "shopify_delete_product", "send_payment", "send_email"],
    autoApproveForRoles: ["admin"],
  });

  it("flags dangerous tool for agent role", () => {
    const result = guard.checkApproval("execute_command", { command: "rm -rf /" }, "agent");
    assert.ok(result !== null);
    assert.equal(result!.toolName, "execute_command");
  });

  it("auto-approves for admin role", () => {
    const result = guard.checkApproval("execute_command", { command: "ls" }, "admin");
    assert.equal(result, null);
  });

  it("allows safe tools without approval", () => {
    const result = guard.checkApproval("fact_assert", { subject: "test" }, "agent");
    assert.equal(result, null);
  });

  it("matches wildcard patterns", () => {
    const g = new ToolGuard({ dangerousTools: ["shopify_delete_*"], autoApproveForRoles: [] });
    const result = g.checkApproval("shopify_delete_collection", {}, "agent");
    assert.ok(result !== null);
  });

  it("redacts sensitive args", () => {
    const result = guard.checkApproval("send_email", {
      to: "user@example.com",
      apiKey: "sk-secret-123",
      body: "hello",
    }, "agent");
    assert.ok(result !== null);
    assert.equal(result!.redactedArgs.apiKey, "[REDACTED]");
    assert.equal(result!.redactedArgs.to, "user@example.com");
  });
});
