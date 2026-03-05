import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "./config.js";
import type { PluginConfig } from "./config.js";

function fakeApi(pluginConfig?: Record<string, unknown>) {
  return { pluginConfig } as Parameters<typeof resolveConfig>[0];
}

describe("resolveConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all relevant env vars
    for (const key of [
      "BACKTEST_API_URL",
      "FINDOO_BACKTEST_URL",
      "OPENFINCLAW_BACKTEST_URL",
      "BACKTEST_API_KEY",
      "FINDOO_BACKTEST_API_KEY",
      "FINDOO_BACKTEST_POLL_INTERVAL",
      "FINDOO_BACKTEST_POLL_TIMEOUT",
      "FINDOO_BACKTEST_REQUEST_TIMEOUT",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns defaults when no config or env vars", () => {
    const cfg = resolveConfig(fakeApi());
    expect(cfg.backtestApiUrl).toBe("http://localhost:8000");
    expect(cfg.backtestApiKey).toBe("");
    expect(cfg.pollIntervalMs).toBe(2_000);
    expect(cfg.pollTimeoutMs).toBe(120_000);
    expect(cfg.requestTimeoutMs).toBe(30_000);
  });

  it("reads from pluginConfig first", () => {
    const cfg = resolveConfig(
      fakeApi({
        backtestApiUrl: "http://remote:9000",
        backtestApiKey: "key-from-config",
        pollIntervalMs: 5000,
        pollTimeoutMs: 300_000,
        requestTimeoutMs: 60_000,
      }),
    );
    expect(cfg.backtestApiUrl).toBe("http://remote:9000");
    expect(cfg.backtestApiKey).toBe("key-from-config");
    expect(cfg.pollIntervalMs).toBe(5_000);
    expect(cfg.pollTimeoutMs).toBe(300_000);
    expect(cfg.requestTimeoutMs).toBe(60_000);
  });

  it("falls back to env vars when pluginConfig empty", () => {
    process.env.BACKTEST_API_URL = "http://env-host:7000";
    process.env.BACKTEST_API_KEY = "env-key";

    const cfg = resolveConfig(fakeApi());
    expect(cfg.backtestApiUrl).toBe("http://env-host:7000");
    expect(cfg.backtestApiKey).toBe("env-key");
  });

  it("prefers BACKTEST_API_URL over FINDOO_BACKTEST_URL", () => {
    process.env.BACKTEST_API_URL = "http://primary:1000";
    process.env.FINDOO_BACKTEST_URL = "http://fallback:2000";

    const cfg = resolveConfig(fakeApi());
    expect(cfg.backtestApiUrl).toBe("http://primary:1000");
  });

  it("falls back to FINDOO_BACKTEST_URL when primary not set", () => {
    process.env.FINDOO_BACKTEST_URL = "http://fallback:2000";

    const cfg = resolveConfig(fakeApi());
    expect(cfg.backtestApiUrl).toBe("http://fallback:2000");
  });

  it("strips trailing slashes from URL", () => {
    const cfg = resolveConfig(fakeApi({ backtestApiUrl: "http://host:8000///" }));
    expect(cfg.backtestApiUrl).toBe("http://host:8000");
  });

  // ── clamp tests ──

  it("clamps pollIntervalMs to [500, 30000]", () => {
    // Below minimum → fallback
    const low = resolveConfig(fakeApi({ pollIntervalMs: 100 }));
    expect(low.pollIntervalMs).toBe(2_000);

    // Above max → capped
    const high = resolveConfig(fakeApi({ pollIntervalMs: 50_000 }));
    expect(high.pollIntervalMs).toBe(30_000);

    // Within range → used
    const mid = resolveConfig(fakeApi({ pollIntervalMs: 3000 }));
    expect(mid.pollIntervalMs).toBe(3_000);
  });

  it("clamps pollTimeoutMs to [5000, 600000]", () => {
    const low = resolveConfig(fakeApi({ pollTimeoutMs: 1000 }));
    expect(low.pollTimeoutMs).toBe(120_000); // fallback

    const high = resolveConfig(fakeApi({ pollTimeoutMs: 999_999 }));
    expect(high.pollTimeoutMs).toBe(600_000); // capped
  });

  it("clamps requestTimeoutMs to [1000, 120000]", () => {
    const low = resolveConfig(fakeApi({ requestTimeoutMs: 500 }));
    expect(low.requestTimeoutMs).toBe(30_000); // fallback

    const high = resolveConfig(fakeApi({ requestTimeoutMs: 200_000 }));
    expect(high.requestTimeoutMs).toBe(120_000); // capped
  });

  it("uses fallback for NaN/non-finite poll values", () => {
    const cfg = resolveConfig(
      fakeApi({
        pollIntervalMs: "not-a-number",
        pollTimeoutMs: Infinity,
        requestTimeoutMs: NaN,
      }),
    );
    expect(cfg.pollIntervalMs).toBe(2_000);
    expect(cfg.pollTimeoutMs).toBe(120_000);
    expect(cfg.requestTimeoutMs).toBe(30_000);
  });

  it("reads poll settings from env vars", () => {
    process.env.FINDOO_BACKTEST_POLL_INTERVAL = "4000";
    process.env.FINDOO_BACKTEST_POLL_TIMEOUT = "200000";
    process.env.FINDOO_BACKTEST_REQUEST_TIMEOUT = "15000";

    const cfg = resolveConfig(fakeApi());
    expect(cfg.pollIntervalMs).toBe(4_000);
    expect(cfg.pollTimeoutMs).toBe(200_000);
    expect(cfg.requestTimeoutMs).toBe(15_000);
  });

  it("pluginConfig overrides env vars", () => {
    process.env.BACKTEST_API_URL = "http://env:1111";
    const cfg = resolveConfig(fakeApi({ backtestApiUrl: "http://config:2222" }));
    expect(cfg.backtestApiUrl).toBe("http://config:2222");
  });
});
