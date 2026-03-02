import { describe, expect, it } from "vitest";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveCompactionModelOverride,
  resolveCompactionThinkLevel,
} from "./compaction-overrides.js";

describe("resolveCompactionModelOverride", () => {
  it("leaves provider/model unchanged when no override configured", () => {
    const res = resolveCompactionModelOverride({
      provider: "openai",
      modelId: "gpt-5.2",
      authProfileId: "profile-1",
      cfg: { agents: { defaults: { compaction: {} } } } as unknown as OpenClawConfig,
    });
    expect(res.provider).toBe("openai");
    expect(res.modelId).toBe("gpt-5.2");
    expect(res.authProfileId).toBe("profile-1");
    expect(res.overrideApplied).toBe(false);
    expect(res.overrideInvalid).toBe(false);
  });

  it("applies compaction model override", () => {
    const res = resolveCompactionModelOverride({
      provider: "openai",
      modelId: "gpt-5.2",
      authProfileId: "profile-1",
      cfg: {
        agents: { defaults: { compaction: { model: "google/gemini-3-flash-preview" } } },
      } as unknown as OpenClawConfig,
    });
    expect(res.provider).toBe("google");
    expect(res.modelId).toBe("gemini-3-flash-preview");
    expect(res.overrideApplied).toBe(true);
  });

  it("drops auth profile id when provider changes", () => {
    const res = resolveCompactionModelOverride({
      provider: "openai",
      modelId: "gpt-5.2",
      authProfileId: "profile-1",
      cfg: {
        agents: { defaults: { compaction: { model: "google/gemini-3-flash-preview" } } },
      } as unknown as OpenClawConfig,
    });
    expect(res.authProfileId).toBeUndefined();
  });
});

describe("resolveCompactionThinkLevel", () => {
  it("defaults to off when model override is applied and no thinking override configured", () => {
    const res = resolveCompactionThinkLevel({
      thinkLevel: "high" as ThinkLevel,
      cfg: { agents: { defaults: { compaction: {} } } } as unknown as OpenClawConfig,
      modelOverrideApplied: true,
    });
    expect(res).toBe("off");
  });

  it("uses configured compaction thinking when set", () => {
    const res = resolveCompactionThinkLevel({
      thinkLevel: "high" as ThinkLevel,
      cfg: {
        agents: { defaults: { compaction: { thinking: "low" } } },
      } as unknown as OpenClawConfig,
      modelOverrideApplied: true,
    });
    expect(res).toBe("low");
  });

  it("falls back to session thinking when no override applied", () => {
    const res = resolveCompactionThinkLevel({
      thinkLevel: "high" as ThinkLevel,
      cfg: { agents: { defaults: { compaction: {} } } } as unknown as OpenClawConfig,
      modelOverrideApplied: false,
    });
    expect(res).toBe("high");
  });
});
