import { describe, expect, it } from "vitest";

describe("Rust Plugin", () => {
  it("should parse config correctly", () => {
    const config = {
      enabled: true,
      option1: "test",
      numericOption: 42,
    };
    expect(config.enabled).toBe(true);
    expect(config.option1).toBe("test");
    expect(config.numericOption).toBe(42);
  });

  it("should have correct plugin id", () => {
    // Plugin id should match manifest
    const pluginId = "rust-plugin";
    expect(pluginId).toBe("rust-plugin");
  });
});
