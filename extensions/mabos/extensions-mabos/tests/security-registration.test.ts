import { describe, it, assert } from "vitest";
import { createSecurityModule } from "../src/security/index.js";

function mockApi(config: Record<string, unknown> = {}): any {
  const hooks: Record<string, Function[]> = {};
  return {
    config: { agents: { defaults: { workspace: "/tmp/mabos-test" } }, ...config },
    pluginConfig: config,
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    on(event: string, handler: Function) {
      hooks[event] = hooks[event] ?? [];
      hooks[event].push(handler);
    },
    _hooks: hooks,
  };
}

describe("Security Module Registration", () => {
  it("registers before_tool_call hook when enabled", () => {
    const api = mockApi({ securityEnabled: true });
    createSecurityModule(api, { securityEnabled: true });
    assert.ok(api._hooks["before_tool_call"]?.length > 0);
  });

  it("registers hooks by default when securityEnabled is undefined", () => {
    const api = mockApi({});
    createSecurityModule(api, {});
    assert.ok(api._hooks["before_tool_call"]?.length > 0);
  });

  it("does not register hooks when explicitly disabled", () => {
    const api = mockApi({ securityEnabled: false });
    createSecurityModule(api, { securityEnabled: false });
    assert.equal(api._hooks["before_tool_call"]?.length ?? 0, 0);
  });
});
