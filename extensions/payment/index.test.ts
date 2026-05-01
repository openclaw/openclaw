import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("payment plugin entry", () => {
  it("exposes id 'payment'", () => {
    expect(plugin.id).toBe("payment");
  });

  it("exposes a name", () => {
    expect(typeof plugin.name).toBe("string");
    expect(plugin.name.length).toBeGreaterThan(0);
  });

  it("exposes a register function", () => {
    expect(typeof plugin.register).toBe("function");
  });
});

describe("payment plugin enabled=false (Codex P2-3)", () => {
  function makeApi(pluginConfig: unknown) {
    return {
      pluginConfig,
      registerTool: vi.fn(),
      registerCli: vi.fn(),
      registerHook: vi.fn(),
      on: vi.fn(), // used by approvals/fill/redaction hooks
    };
  }

  it("does NOT register payment tool when enabled=false", () => {
    const api = makeApi({ enabled: false, provider: "mock" });
    plugin.register(api as never);
    // registerTool should not have been called
    expect(api.registerTool).not.toHaveBeenCalled();
  });

  it("does NOT register CLI when enabled=false", () => {
    const api = makeApi({ enabled: false, provider: "mock" });
    plugin.register(api as never);
    expect(api.registerCli).not.toHaveBeenCalled();
  });

  it("still registers redaction hook even when disabled (defense-in-depth)", () => {
    const api = makeApi({ enabled: false, provider: "mock" });
    plugin.register(api as never);
    // api.on() is called for hook registration (redaction hook)
    expect(api.on).toHaveBeenCalled();
  });

  it("registers all surfaces when enabled=true", () => {
    const api = makeApi({ enabled: true, provider: "mock" });
    plugin.register(api as never);
    expect(api.registerTool).toHaveBeenCalled();
    expect(api.registerCli).toHaveBeenCalled();
  });
});
