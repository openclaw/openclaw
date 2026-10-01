import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "../doctor-contract-api.js";

describe("FaceTime doctor config compatibility", () => {
  it("migrates the deployed legacy config to the strict canonical shape", () => {
    const cfg = {
      plugins: {
        entries: {
          facetime: {
            enabled: true,
            config: {
              enabled: true,
              helperHost: "127.0.0.1",
              helperPort: 45670,
              whitelistHandles: ["owner@example.com", "+12065550123"],
              realtime: {
                brain: "agent-consult",
                provider: "openai",
                model: "gpt-realtime-2.1",
                sessionKey: "main",
                toolPolicy: "owner",
                voice: "marin",
              },
            },
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg });

    expect(result.config).not.toBe(cfg);
    expect(cfg.plugins.entries.facetime.config).toHaveProperty("helperHost");
    expect(result.config.plugins?.entries?.facetime?.config).toEqual({
      enabled: true,
      ownerHandles: ["owner@example.com", "+12065550123"],
      realtime: {
        provider: "openai",
        model: "gpt-realtime-2.1",
        sessionKey: "main",
        toolPolicy: "owner",
        voice: "marin",
      },
    });
    expect(result.changes).toEqual([
      "Moved plugins.entries.facetime.config.whitelistHandles to plugins.entries.facetime.config.ownerHandles.",
      "Removed retired plugins.entries.facetime.config.helperHost.",
      "Removed retired plugins.entries.facetime.config.helperPort.",
      "Removed retired plugins.entries.facetime.config.realtime.brain.",
    ]);
  });

  it("keeps canonical owner handles authoritative and is idempotent", () => {
    const cfg = {
      plugins: {
        entries: {
          facetime: {
            config: {
              ownerHandles: ["current@example.com"],
              whitelistHandles: ["retired@example.com"],
            },
          },
        },
      },
    };

    const first = normalizeCompatibilityConfig({ cfg });
    const second = normalizeCompatibilityConfig({ cfg: first.config });

    expect(first.config.plugins?.entries?.facetime?.config).toEqual({
      ownerHandles: ["current@example.com"],
    });
    expect(first.changes).toEqual([
      "Removed plugins.entries.facetime.config.whitelistHandles; plugins.entries.facetime.config.ownerHandles is authoritative.",
    ]);
    expect(second).toEqual({ config: first.config, changes: [] });
  });

  it("declares every retired path for doctor warnings", () => {
    expect(legacyConfigRules.map((rule) => rule.path)).toEqual([
      ["plugins", "entries", "facetime", "config", "whitelistHandles"],
      ["plugins", "entries", "facetime", "config", "helperHost"],
      ["plugins", "entries", "facetime", "config", "helperPort"],
      ["plugins", "entries", "facetime", "config", "realtime", "brain"],
    ]);
  });
});
