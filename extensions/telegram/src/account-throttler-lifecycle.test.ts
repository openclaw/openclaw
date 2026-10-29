import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  releaseRemovedTelegramAccountThrottler,
  releaseRotatedTelegramAccountThrottler,
  releaseRetiredTelegramAccountThrottler,
} from "./account-throttler-lifecycle.js";
import { getOrCreateAccountThrottler, releaseAccountThrottler } from "./account-throttler.js";

const config = (accounts: Record<string, { botToken: string }>): OpenClawConfig => ({
  channels: { telegram: { accounts } },
});
afterEach(() => vi.unstubAllEnvs());
describe("token ownership retirement", () => {
  it("normalizes removed IDs and keeps a mixed-case surviving alias", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const token = "123:alias";
    const account = getOrCreateAccountThrottler(token);
    const cfg = config({ Ops: { botToken: token }, Backup: { botToken: token } });
    expect(await releaseRemovedTelegramAccountThrottler(cfg, " OPS ")).toBe(false);
    expect(getOrCreateAccountThrottler(token)).toBe(account);
    expect(
      await releaseRetiredTelegramAccountThrottler(token, config({ Backup: { botToken: token } })),
    ).toBe(false);
    expect(
      await releaseRemovedTelegramAccountThrottler(config({ Ops: { botToken: token } }), " OPS "),
    ).toBe(true);
    expect(await releaseAccountThrottler(token)).toBe(false);
  });
  it("rotates without waiting for old disposal and cannot delete the recreated owner", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const dispose = vi.fn(() => waiting);
    const old = getOrCreateAccountThrottler("123:old", () => ({
      transformer: (prev, ...args) => prev(...args),
      dispose,
    }));
    expect(
      await releaseRotatedTelegramAccountThrottler(
        config({ Ops: { botToken: "123:old" } }),
        config({ Ops: { botToken: "456:new" } }),
        " OPS ",
      ),
    ).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    const replacement = getOrCreateAccountThrottler("123:old");
    expect(replacement).not.toBe(old);
    finish();
    await waiting;
    expect(getOrCreateAccountThrottler("123:old")).toBe(replacement);
    await releaseAccountThrottler("123:old");
  });
});
