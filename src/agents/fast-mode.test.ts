import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { formatFastModeAutoLabel } from "../shared/fast-mode.js";
import {
  formatFastModeAutoProgressText,
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  formatFastModeStatusValue,
  resolveFastModeForElapsed,
  resolveFastModeState,
} from "./fast-mode.js";

function resolve(options: Partial<Parameters<typeof resolveFastModeState>[0]> = {}) {
  return resolveFastModeState({ cfg: {}, provider: "openai", model: "gpt-5.5", ...options });
}
function modelConfig(
  params: Record<string, unknown>,
  key = "openai/gpt-5.5",
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {},
): OpenClawConfig {
  return { agents: { defaults: { ...defaults, models: { [key]: { params } } } } };
}

describe("resolveFastModeState", () => {
  it.each(["serviceTier", "service_tier"])(
    "keeps %s inherited until a speed is selected",
    (key) => {
      const cfg = modelConfig({ [key]: "ultrafast" }, "openai/speed-fixture");
      const state = resolve({ cfg, provider: "openai", model: "speed-fixture" });
      expect(state).toMatchObject({ mode: "ultrafast", source: "config" });
      expect(state.requestMode).toBeUndefined();
      for (const mode of [false, true, "ultrafast"] as const) {
        expect(
          resolve({
            cfg,
            model: "speed-fixture",
            sessionEntry: { fastMode: mode },
          }),
        ).toMatchObject({ mode, requestMode: mode, source: "session" });
      }
    },
  );

  it("prefers session overrides over per-agent and global defaults", () => {
    const state = resolve({
      cfg: {
        agents: {
          defaults: { fastModeDefault: "auto" },
          entries: { main: { fastModeDefault: false } },
        },
      } as OpenClawConfig,
      model: "gpt-4o",
      agentId: "main",
      sessionEntry: { fastMode: true },
    });

    expect(state).toMatchObject({ enabled: true, mode: true, source: "session" });
  });

  it.each(["auto", "ultrafast"] as const)(
    "keeps %s as the persisted mode and starts enabled",
    (mode) => {
      const state = resolve({
        sessionEntry: { fastMode: mode },
      });

      expect(state).toMatchObject({ mode, enabled: true });
    },
  );

  it("uses rosterless global fastModeDefault over model config", () => {
    const cfg = modelConfig({ fastMode: false }, "openai/gpt-4o", { fastModeDefault: true });

    const state = resolve({
      cfg,
      model: "gpt-4o",
      agentId: "main",
    });

    expect(state).toMatchObject({ mode: true, enabled: true, source: "agent" });
  });

  it("prefers per-agent fastModeDefault over the global default", () => {
    const cfg: OpenClawConfig = {
      agents: {
        ...modelConfig({ fastMode: true }, "openai/gpt-4o", { fastModeDefault: true }).agents,
        entries: { main: { fastModeDefault: false } },
      },
    };

    const state = resolve({
      cfg,
      model: "gpt-4o",
      agentId: "main",
    });

    expect(state).toMatchObject({ mode: false, source: "agent" });
  });

  it("formats auto mode with the default threshold", () => {
    expect(formatFastModeAutoLabel()).toBe("auto (60 sec)");
    expect(formatFastModeStatusValue({ mode: "auto" })).toBe("auto (60 sec)");
    expect(formatFastModeAutoLabel({ fastAutoOnSeconds: 30 })).toBe("auto (30 sec)");
    expect(formatFastModeStatusValue({ mode: "auto", fastAutoOnSeconds: 30 })).toBe(
      "auto (30 sec)",
    );
    expect(formatFastModeStatusValue({ mode: true })).toBe("on");
    expect(formatFastModeStatusValue({ mode: "ultrafast" })).toBe("ultrafast");
    expect(formatFastModeCommandOptions({ fastAutoOnSeconds: 30 })).toBe(
      "on, off, ultrafast, auto (30 sec), default, status",
    );
    expect(
      formatFastModeCurrentStatus({
        mode: "auto",
        source: "config",
        fastAutoOnSeconds: 30,
      }),
    ).toBe("Current fast mode: auto (30 sec) (default: model).");
  });

  it("uses model fastAutoOnSeconds for auto cutoff across session overrides", () => {
    const cfg = modelConfig({ fastMode: "auto", fastAutoOnSeconds: 30 });

    const state = resolve({
      cfg,
      sessionEntry: { fastMode: "auto" },
    });

    expect(state).toMatchObject({ mode: "auto", source: "session", fastAutoOnSeconds: 30 });
  });

  it("uses model fast_seconds alias for auto cutoff", () => {
    const cfg = modelConfig({ fastMode: "auto", fast_seconds: 15 });

    const state = resolve({
      cfg,
    });

    expect(state).toMatchObject({ mode: "auto", source: "config", fastAutoOnSeconds: 15 });
  });

  it.each([
    ["openai/gpt-5.5", "openai", "openai/gpt-5.5", true, "config"],
    [
      "openrouter/anthropic/claude-sonnet-4-6",
      "openrouter",
      "anthropic/claude-sonnet-4-6",
      true,
      "config",
    ],
    ["anthropic/claude-sonnet-4-6", "openrouter", "anthropic/claude-sonnet-4-6", false, "default"],
  ] as const)("scopes model config %s to provider %s", (key, provider, model, enabled, source) => {
    expect(resolve({ cfg: modelConfig({ fastMode: true }, key), provider, model })).toMatchObject({
      enabled,
      source,
    });
  });
});

describe("resolveFastModeForElapsed", () => {
  it("uses configured auto seconds as the elapsed threshold", () => {
    const input = { mode: "auto" as const, fastAutoOnSeconds: 30, startedAtMs: 1_000 };
    const expected = { mode: "auto", elapsedSeconds: 30, fastAutoOnSeconds: 30 };
    expect(resolveFastModeForElapsed({ ...input, nowMs: 31_000 })).toMatchObject({
      ...expected,
      enabled: true,
    });
    expect(resolveFastModeForElapsed({ ...input, nowMs: 31_001 })).toMatchObject({
      ...expected,
      enabled: false,
    });
  });

  it("formats auto transition progress", () => {
    expect(
      formatFastModeAutoProgressText({
        enabled: false,
        elapsedSeconds: 75,
        fastAutoOnSeconds: 30,
      }),
    ).toBe("💨Fast: auto-off(75s>=30s)");
    expect(
      formatFastModeAutoProgressText({
        enabled: true,
        elapsedSeconds: 0,
      }),
    ).toBe("💨Fast: auto-on");
  });
});
