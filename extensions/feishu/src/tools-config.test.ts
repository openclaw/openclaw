import { describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import { resolveToolsConfig } from "./tools-config.js";

describe("feishu tools config", () => {
  it("enables chat tool by default", () => {
    const resolved = resolveToolsConfig(undefined);
    expect(resolved.chat).toBe(true);
  });

  it("keeps native reaction tools opt-in by default", () => {
    const resolved = resolveToolsConfig(undefined);
    expect(resolved.reactions).toBe(false);
  });

  it("accepts tools.chat in config schema", () => {
    const parsed = FeishuConfigSchema.parse({
      enabled: true,
      tools: {
        chat: false,
        reactions: false,
      },
    });

    expect(parsed.tools?.chat).toBe(false);
    expect(parsed.tools?.reactions).toBe(false);
  });
});
