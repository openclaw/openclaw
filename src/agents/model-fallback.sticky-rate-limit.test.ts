import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithModelFallback } from "./model-fallback-runner.js";
import { MODEL_FALLBACK_SKIPPED_CODE } from "./model-fallback.types.js";

const start = Date.UTC(2026, 0, 1);
const minute = 60_000;

function runTurn(
  sessionId: string,
  run: Parameters<typeof runWithModelFallback<string>>[0]["run"],
  stickyRateLimitFallback?: boolean,
) {
  return runWithModelFallback({
    cfg: { plugins: { enabled: false } },
    provider: "sticky-provider",
    model: "primary",
    fallbacksOverride: ["sticky-provider/backup"],
    manifestPlugins: [],
    skipAuthProfileRuntime: true,
    sessionId,
    stickyRateLimitFallback,
    run,
  });
}

function failPrimary(status = 429) {
  return vi.fn(async (_provider: string, model: string) => {
    if (model === "primary") {
      throw Object.assign(new Error("synthetic provider failure"), { status });
    }
    return "backup reply";
  });
}

async function expectSelectedModel(sessionId: string, model: string) {
  const run = vi.fn<Parameters<typeof runWithModelFallback<string>>[0]["run"]>(
    async (_provider, selected) => selected,
  );
  const result = await runTurn(sessionId, run, true);
  expect(result.result).toBe(model);
  return { run, result };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session rate-limit fallback stickiness", () => {
  it("keeps the fallback warm only for the rate-limited session until idle expiry", async () => {
    const first = failPrimary();
    const result = await runTurn("sticky-session", first, true);
    expect(first.mock.calls.map(([, model]) => model)).toEqual(["primary", "backup"]);
    expect(result.attempts).toMatchObject([{ model: "primary", reason: "rate_limit" }]);

    await expectSelectedModel("other-session", "primary");

    vi.setSystemTime(start + minute);
    const { run: second, result: warm } = await expectSelectedModel("sticky-session", "backup");
    // The skipped selected model keeps the rate-limit reason visible to /status.
    expect(warm.attempts).toMatchObject([
      { model: "primary", reason: "rate_limit", code: MODEL_FALLBACK_SKIPPED_CODE },
    ]);
    expect(second.mock.calls[0]?.[2]?.modelRoutingProvenance).toMatchObject({
      stage: "fallback",
      fallbackReason: "rate_limit",
    });

    vi.setSystemTime(start + 11 * minute + 1);
    await expectSelectedModel("sticky-session", "primary");
  });

  it("caps sliding reuse at 30 minutes and clears a failed sticky attempt", async () => {
    await runTurn("sticky-session", failPrimary(), true);
    for (const minutes of [5, 10, 15, 20, 25, 30]) {
      vi.setSystemTime(start + minutes * minute);
      await expectSelectedModel("sticky-session", "backup");
    }
    vi.setSystemTime(start + 30 * minute + 1);
    await expectSelectedModel("sticky-session", "primary");

    await runTurn("sticky-session", failPrimary(), true);
    const failingSticky = vi.fn(async (_provider: string, model: string) => {
      if (model === "backup") {
        throw Object.assign(new Error("synthetic server error"), { status: 500 });
      }
      return "primary reply";
    });
    await runTurn("sticky-session", failingSticky, true);
    expect(failingSticky.mock.calls.map(([, model]) => model)).toEqual(["backup", "primary"]);
    await expectSelectedModel("sticky-session", "primary");
  });

  it("does not stick after other failures or without the opt-in", async () => {
    for (const { status, enabled } of [
      { status: 500, enabled: true },
      { status: 429, enabled: undefined },
    ]) {
      const first = failPrimary(status);
      await runTurn("sticky-session", first, enabled);
      expect(first.mock.calls.map(([, model]) => model)).toEqual(["primary", "backup"]);
      await expectSelectedModel("sticky-session", "primary");
    }
  });
});
