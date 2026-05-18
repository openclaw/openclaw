import { describe, expect, it } from "vitest";
import { FeishuConfigSchema } from "./config-schema.js";
import { resolveToolsConfig } from "./tools-config.js";

describe("feishu tools config", () => {
  it("enables chat tool by default", () => {
    const resolved = resolveToolsConfig(undefined);
    expect(resolved.chat).toBe(true);
  });

  it("keeps message tools disabled by default", () => {
    const resolved = resolveToolsConfig(undefined);
    expect(resolved.messages).toBe(false);
  });

  it("accepts tool gates in config schema", () => {
    const parsed = FeishuConfigSchema.parse({
      enabled: true,
      tools: {
        chat: false,
        messages: false,
      },
    });

    expect(parsed.tools?.chat).toBe(false);
    expect(parsed.tools?.messages).toBe(false);
  });
});
