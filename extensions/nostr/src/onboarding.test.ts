import type { OpenClawConfig, RuntimeEnv, WizardPrompter } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { nostrOnboardingAdapter } from "./onboarding.js";

const TEST_PRIVATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("nostr onboarding", () => {
  it("reports configured and unconfigured status", async () => {
    const empty = await nostrOnboardingAdapter.getStatus({
      cfg: {} as OpenClawConfig,
      accountOverrides: {},
    });
    expect(empty.configured).toBe(false);
    expect(empty.statusLines[0]).toContain("needs private key");

    const configured = await nostrOnboardingAdapter.getStatus({
      cfg: { channels: { nostr: { privateKey: TEST_PRIVATE_KEY } } } as OpenClawConfig,
      accountOverrides: {},
    });
    expect(configured.configured).toBe(true);
    expect(configured.statusLines[0]).toContain("configured");
  });

  it("collects private key and relays and patches config", async () => {
    const prompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
      multiselect: vi.fn(async () => []) as unknown as WizardPrompter["multiselect"],
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message.includes("private key")) {
          return TEST_PRIVATE_KEY;
        }
        if (message.includes("Nostr relay URLs")) {
          return "wss://relay.damus.io,\n wss://relay.primal.net, wss://relay.damus.io";
        }
        if (message.includes("Your sender pubkey")) {
          return "";
        }
        throw new Error(`Unexpected text prompt: ${message}`);
      }) as WizardPrompter["text"],
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    } satisfies WizardPrompter;

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

  it("generates a private key when left blank", async () => {
    const prompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
      multiselect: vi.fn(async () => []) as unknown as WizardPrompter["multiselect"],
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message.includes("private key")) {
          return "";
        }
        if (message.includes("Nostr relay URLs")) {
          return "wss://relay.damus.io,\n wss://relay.primal.net, wss://relay.damus.io";
        }
        if (message.includes("sender pubkey")) {
          return "";
        }
        throw new Error(`Unexpected text prompt: ${message}`);
      }) as WizardPrompter["text"],
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    } satisfies WizardPrompter;

    const result = await nostrOnboardingAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.cfg.channels?.nostr?.enabled).toBe(true);
    expect(result.cfg.channels?.nostr?.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.cfg.channels?.nostr?.relays).toEqual([
      "wss://relay.damus.io",
      "wss://relay.primal.net",
    ]);
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Generated a Nostr keypair"),
      "Nostr identity generated",
    );
  });

  it("collects sender pubkey and optional profile metadata", async () => {
    const prompter = {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
      multiselect: vi.fn(async () => []) as unknown as WizardPrompter["multiselect"],
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message.includes("private key")) {
          return TEST_PRIVATE_KEY;
        }
        if (message.includes("Nostr relay URLs")) {
          return "wss://relay.damus.io,\n wss://relay.primal.net, wss://relay.damus.io";
        }
        if (message.includes("Your sender pubkey")) {
          return "npub1examplesender123456789012345";
        }
        if (message.includes("Profile name")) {
          return "OpenClaw Bot";
        }
        if (message.includes("Profile display name")) {
          return "";
        }
        if (message.includes("Profile about/bio")) {
          return "Nostr automation assistant";
        }
        if (message.includes("Profile picture URL")) {
          return "";
        }
        if (message.includes("Profile banner URL")) {
          return "";
        }
        if (message.includes("Profile website URL")) {
          return "https://example.com";
        }
        if (message.includes("NIP-05 identifier")) {
          return "";
        }
        if (message.includes("LUD-16 address")) {
          return "";
        }
        throw new Error(`Unexpected text prompt: ${message}`);
      }) as WizardPrompter["text"],
      confirm: vi.fn(async ({ message }: { message: string }) =>
        message.includes("Set up Nostr profile metadata now"),
      ),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    } satisfies WizardPrompter;

    const result = await nostrOnboardingAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.cfg.channels?.nostr?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.nostr?.allowFrom).toEqual(["npub1examplesender123456789012345"]);
    expect(result.cfg.channels?.nostr?.profile).toEqual({
      name: "OpenClaw Bot",
      about: "Nostr automation assistant",
      website: "https://example.com",
    });
  });
});
