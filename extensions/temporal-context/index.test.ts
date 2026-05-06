import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import plugin, { describeElapsed } from "./index.js";

function createApi(statePath: string, extraConfig: Record<string, unknown> = {}) {
  const hooks: Record<string, (...args: unknown[]) => unknown> = {};
  const services: unknown[] = [];
  const api = {
    pluginConfig: {
      timeZone: "America/Toronto",
      locale: "en-CA",
      statePath,
      ...extraConfig,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
      hooks[name] = handler;
    }),
    registerService: vi.fn((service: unknown) => services.push(service)),
  };
  plugin.register(api as never);
  return { api, hooks, services };
}

describe("temporal-context plugin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("formats elapsed time compactly", () => {
    expect(describeElapsed(3_000)).toBe("just now");
    expect(describeElapsed(45_000)).toBe("45 seconds");
    expect(describeElapsed(60_000)).toBe("1 minute");
    expect(describeElapsed(2 * 60 * 60 * 1000)).toBe("2 hours");
  });

  test("injects current local time and records session state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-temporal-context-"));
    const statePath = join(dir, "state.json");
    const { api, hooks } = createApi(statePath);

    vi.setSystemTime(new Date("2026-05-06T12:13:25.000Z"));
    const result = await hooks.before_prompt_build(
      { prompt: "hello", messages: [] },
      { sessionKey: "agent:main:telegram:123", messageProvider: "telegram" },
    );

    expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function), {
      priority: 20,
      timeoutMs: 750,
    });
    expect(result).toEqual({
      prependSystemContext: expect.stringContaining("Current local date: Wednesday, May 6, 2026"),
    });
    const context = (result as { prependSystemContext: string }).prependSystemContext;
    expect(context).toContain("Conversation surface: telegram");
    expect(context).toContain(
      "Time since previous user turn in this session: no previous turn recorded",
    );

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.sessions["agent:main:telegram:123"].turnCount).toBe(1);
  });

  test("injects elapsed time since the previous user turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-temporal-context-"));
    const statePath = join(dir, "state.json");
    const { hooks } = createApi(statePath);

    vi.setSystemTime(new Date("2026-05-06T12:00:00.000Z"));
    await hooks.before_prompt_build({ prompt: "first", messages: [] }, { sessionKey: "session-1" });

    vi.setSystemTime(new Date("2026-05-06T12:03:00.000Z"));
    const result = await hooks.before_prompt_build(
      { prompt: "second", messages: [] },
      { sessionKey: "session-1" },
    );

    const context = (result as { prependSystemContext: string }).prependSystemContext;
    expect(context).toContain("Time since previous user turn in this session: 3 minutes");
  });

  test("is inert when disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openclaw-temporal-context-"));
    const statePath = join(dir, "state.json");
    const { hooks } = createApi(statePath, { enabled: false });

    const result = await hooks.before_prompt_build(
      { prompt: "hello", messages: [] },
      { sessionKey: "session-1" },
    );

    expect(result).toBeUndefined();
  });
});
