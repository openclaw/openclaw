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

  it.each([
    [true, false, "auto", undefined, true, "session"],
    ["auto", undefined, undefined, undefined, "auto", "session"],
    ["ultrafast", undefined, undefined, undefined, "ultrafast", "session"],
    [undefined, undefined, true, false, true, "agent"],
    [undefined, false, true, true, false, "agent"],
  ] as const)(
    "resolves session=%s, agent=%s, global=%s, model=%s by priority",
    (session, agent, global, modelMode, mode, source) => {
      const configured = global !== undefined;
      const cfg: OpenClawConfig = configured
        ? modelConfig(modelMode === undefined ? {} : { fastMode: modelMode }, "openai/gpt-4o", {
            fastModeDefault: global,
          })
        : {};
      if (agent !== undefined) {
        cfg.agents = { ...cfg.agents, entries: { main: { fastModeDefault: agent } } };
      }
      expect(
        resolve({
          cfg,
          ...(configured ? { model: "gpt-4o", agentId: "main" } : {}),
          sessionEntry: { fastMode: session },
        }),
      ).toMatchObject({ mode, enabled: mode !== false, source });
    },
  );

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

  it.each([
    ["fastAutoOnSeconds", 30, { fastMode: "auto" as const }, "session"],
    ["fast_seconds", 15, undefined, "config"],
  ] as const)("uses model %s for auto cutoff", (key, seconds, sessionEntry, source) => {
    expect(
      resolve({ cfg: modelConfig({ fastMode: "auto", [key]: seconds }), sessionEntry }),
    ).toMatchObject({ mode: "auto", source, fastAutoOnSeconds: seconds });
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
