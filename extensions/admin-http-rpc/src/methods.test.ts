// Focused coverage for the Admin HTTP RPC method allowlist, including the
// agents.setDefault entry that must cross the trusted operator HTTP surface.
import { describe, expect, it } from "vitest";
import { isAdminHttpRpcAllowedMethod, listAdminHttpRpcAllowedMethods } from "./methods.js";

describe("admin HTTP RPC allowlist", () => {
  it("exposes the full agents surface including setDefault", () => {
    const methods = listAdminHttpRpcAllowedMethods();
    for (const method of [
      "agents.list",
      "agents.create",
      "agents.update",
      "agents.setDefault",
      "agents.delete",
    ]) {
      expect(methods).toContain(method);
    }
  });

  it("allows agents.setDefault and rejects unlisted methods", () => {
    expect(isAdminHttpRpcAllowedMethod("agents.setDefault")).toBe(true);
    expect(isAdminHttpRpcAllowedMethod("agents.bogus")).toBe(false);
    expect(isAdminHttpRpcAllowedMethod("sessions.send")).toBe(false);
  });
});
