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

  it("returns off when thinking is explicitly off", () => {
    const cfg = {
      agents: { defaults: { compaction: { thinking: "off" } } },
    } as unknown as OpenClawConfig;
    expect(resolveCompactionThinkLevel({ cfg })).toBe("off");
  });

  it("inherits session thinking level when thinking is on", () => {
    const cfg = {
      agents: { defaults: { compaction: { thinking: "on" } } },
    } as unknown as OpenClawConfig;
    expect(resolveCompactionThinkLevel({ cfg, sessionThinkLevel: "medium" })).toBe("medium");
  });

  it("falls back to off when thinking is on but no session level is provided", () => {
    const cfg = {
      agents: { defaults: { compaction: { thinking: "on" } } },
    } as unknown as OpenClawConfig;
    expect(resolveCompactionThinkLevel({ cfg })).toBe("off");
  });
});
