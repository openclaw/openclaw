import type { OpenClawConfig, RuntimeEnv, WizardPrompter } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { nostrOnboardingAdapter } from "./onboarding.js";

const TEST_PRIVATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("nostr onboarding", () => {
  it("reports configured and unconfigured status", async () => {
    const empty = await nostrOnboardingAdapter.getStatus({ cfg: {} as OpenClawConfig });
    expect(empty.configured).toBe(false);
    expect(empty.statusLines[0]).toContain("needs private key");

    const configured = await nostrOnboardingAdapter.getStatus({
      cfg: { channels: { nostr: { privateKey: TEST_PRIVATE_KEY } } } as OpenClawConfig,
    });
    expect(configured.configured).toBe(true);
    expect(configured.statusLines[0]).toContain("configured");
  });

  it("collects private key and relays and patches config", async () => {
    const prompter: WizardPrompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select: vi.fn(async () => ""),
      multiselect: vi.fn(async () => []),
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message.includes("Nostr private key")) {
          return TEST_PRIVATE_KEY;
        }
        if (message.includes("Nostr relay URLs")) {
          return "wss://relay.damus.io,\n wss://relay.primal.net, wss://relay.damus.io";
        }
        throw new Error(`Unexpected text prompt: ${message}`);
      }) as WizardPrompter["text"],
      confirm: vi.fn(async () => true),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    };

    const result = await nostrOnboardingAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.nostr?.enabled).toBe(true);
    expect(result.cfg.channels?.nostr?.privateKey).toBe(TEST_PRIVATE_KEY);
    expect(result.cfg.channels?.nostr?.relays).toEqual([
      "wss://relay.damus.io",
      "wss://relay.primal.net",
    ]);
  });
});
