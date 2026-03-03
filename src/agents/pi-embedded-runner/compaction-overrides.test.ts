import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveCompactionThinkLevel } from "./compaction-overrides.js";

describe("resolveCompactionThinkLevel", () => {
  it("defaults to off with no config", () => {
    expect(resolveCompactionThinkLevel({})).toBe("off");
  });

  it("defaults to off when compaction.thinking is not set", () => {
    const cfg = { agents: { defaults: { compaction: {} } } } as unknown as OpenClawConfig;
    expect(resolveCompactionThinkLevel({ cfg })).toBe("off");
  });

  it("returns the configured thinking level", () => {
    const cfg = {
      agents: { defaults: { compaction: { thinking: "low" } } },
    } as unknown as OpenClawConfig;
    expect(resolveCompactionThinkLevel({ cfg })).toBe("low");
  });

  it("explicit off is the same as the default", () => {
    const cfg = {
      agents: { defaults: { compaction: { thinking: "off" } } },
    } as unknown as OpenClawConfig;
    expect(resolveCompactionThinkLevel({ cfg })).toBe("off");
  });
});
