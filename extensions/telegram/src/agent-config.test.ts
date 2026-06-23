import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  resolveConfiguredTypingMode,
  resolveTelegramConfigReasoningDefault,
} from "./agent-config.js";

describe("resolveConfiguredTypingMode", () => {
  it("returns undefined when no typing mode is configured anywhere", () => {
    const cfg = { agents: {} } as OpenClawConfig;
    expect(resolveConfiguredTypingMode(cfg)).toBeUndefined();
  });

  it("returns the agents.defaults typing mode", () => {
    const cfg = {
      agents: { defaults: { typingMode: "instant" } },
    } as OpenClawConfig;
    expect(resolveConfiguredTypingMode(cfg)).toBe("instant");
  });

  it("prefers the session override over agents.defaults", () => {
    const cfg = {
      session: { typingMode: "message" },
      agents: { defaults: { typingMode: "instant" } },
    } as OpenClawConfig;
    expect(resolveConfiguredTypingMode(cfg)).toBe("message");
  });
});

describe("resolveTelegramConfigReasoningDefault", () => {
  it("keeps existing fallback behavior", () => {
    const cfg = { agents: {} } as OpenClawConfig;
    expect(resolveTelegramConfigReasoningDefault(cfg, "main")).toBe("off");
  });
});
