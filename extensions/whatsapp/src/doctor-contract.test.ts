import { describe, expect, it } from "vitest";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";

type Cfg = Parameters<typeof normalizeCompatibilityConfig>[0]["cfg"];

const baseCfg = (overrides: Partial<Cfg> = {}): Cfg =>
  ({ channels: { whatsapp: {} }, ...overrides }) as Cfg;

describe("normalizeCompatibilityConfig (whatsapp ackReaction migration)", () => {
  it("no-ops when messages.ackReaction is absent", () => {
    const cfg = baseCfg();
    const { config, changes } = normalizeCompatibilityConfig({ cfg });
    expect(config).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("no-ops when whatsapp channel is not configured", () => {
    const cfg = { messages: { ackReaction: "👍" } } as unknown as Cfg;
    const { config, changes } = normalizeCompatibilityConfig({ cfg });
    expect(config).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("no-ops when ackReaction is already set on whatsapp channel", () => {
    const cfg = baseCfg({
      messages: { ackReaction: "👍" },
      channels: { whatsapp: { ackReaction: { emoji: "👍", direct: true, group: "always" } } },
    } as Partial<Cfg>);
    const { config, changes } = normalizeCompatibilityConfig({ cfg });
    expect(config).toBe(cfg);
    expect(changes).toHaveLength(0);
  });

  it("migrates scope=all → direct:true group:always", () => {
    const cfg = baseCfg({
      messages: { ackReaction: "👍", ackReactionScope: "all" },
    } as Partial<Cfg>);
    const { config, changes } = normalizeCompatibilityConfig({ cfg });
    expect((config as Cfg).channels?.whatsapp?.ackReaction).toEqual({
      emoji: "👍",
      direct: true,
      group: "always",
    });
    expect(changes).toHaveLength(1);
  });

  it("migrates scope=direct → direct:true group:never", () => {
    const cfg = baseCfg({
      messages: { ackReaction: "✅", ackReactionScope: "direct" },
    } as Partial<Cfg>);
    const { config } = normalizeCompatibilityConfig({ cfg });
    expect((config as Cfg).channels?.whatsapp?.ackReaction).toEqual({
      emoji: "✅",
      direct: true,
      group: "never",
    });
  });

  it("migrates scope=group-all → direct:false group:always", () => {
    const cfg = baseCfg({
      messages: { ackReaction: "🎉", ackReactionScope: "group-all" },
    } as Partial<Cfg>);
    const { config } = normalizeCompatibilityConfig({ cfg });
    expect((config as Cfg).channels?.whatsapp?.ackReaction).toEqual({
      emoji: "🎉",
      direct: false,
      group: "always",
    });
  });

  it("migrates scope=group-mentions (default) → direct:false group:mentions", () => {
    const cfg = baseCfg({
      messages: { ackReaction: "👀", ackReactionScope: "group-mentions" },
    } as Partial<Cfg>);
    const { config } = normalizeCompatibilityConfig({ cfg });
    expect((config as Cfg).channels?.whatsapp?.ackReaction).toEqual({
      emoji: "👀",
      direct: false,
      group: "mentions",
    });
  });

  it("defaults missing ackReactionScope to group-mentions behavior", () => {
    const cfg = baseCfg({
      messages: { ackReaction: "🔔" },
    } as Partial<Cfg>);
    const { config } = normalizeCompatibilityConfig({ cfg });
    expect((config as Cfg).channels?.whatsapp?.ackReaction).toEqual({
      emoji: "🔔",
      direct: false,
      group: "mentions",
    });
  });

  it("trims whitespace from legacy ackReaction value", () => {
    const cfg = baseCfg({
      messages: { ackReaction: "  👍  " },
    } as Partial<Cfg>);
    const { config } = normalizeCompatibilityConfig({ cfg });
    expect((config as Cfg).channels?.whatsapp?.ackReaction?.emoji).toBe("👍");
  });
});
