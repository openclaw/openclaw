import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect } from "vitest";

type WhatsAppSetupConfig = Pick<OpenClawConfig, "channels">;

type WizardPromptHarness = Record<"text" | "select" | "note", (...args: unknown[]) => unknown>;

type QueuedWizardPrompterFactory<T extends WizardPromptHarness> = (params: {
  confirmValues?: boolean[];
  selectValues?: string[];
  textValues?: string[];
}) => T;

const WHATSAPP_OWNER_NUMBER_INPUT = "+1 (555) 555-0123";
const WHATSAPP_OWNER_NUMBER_E164 = "+15555550123";
const WHATSAPP_OWNER_NUMBER = "15555550123";

export function createWhatsAppRootAllowFromConfig(): WhatsAppSetupConfig {
  return { channels: { whatsapp: { allowFrom: [WHATSAPP_OWNER_NUMBER_E164] } } };
}

export function createWhatsAppOwnerAllowlistHarness<T extends WizardPromptHarness>(
  createPrompter: QueuedWizardPrompterFactory<T>,
): T {
  return createPrompter({
    confirmValues: [false],
    textValues: [WHATSAPP_OWNER_NUMBER_INPUT],
  });
}

export function createWhatsAppPersonalPhoneHarness<T extends WizardPromptHarness>(
  createPrompter: QueuedWizardPrompterFactory<T>,
): T {
  return createPrompter({
    confirmValues: [false],
    selectValues: ["personal"],
    textValues: ["+1 (555) 111-2222"],
  });
}

export function createWhatsAppLinkingHarness<T extends WizardPromptHarness>(
  createPrompter: QueuedWizardPrompterFactory<T>,
): T {
  return createPrompter({
    confirmValues: [true],
    selectValues: ["separate", "disabled"],
  });
}

export function createWhatsAppWorkAccountConfig(
  params: { defaultAccount?: string } = {},
): WhatsAppSetupConfig {
  return {
    channels: {
      whatsapp: {
        ...(params.defaultAccount ? { defaultAccount: params.defaultAccount } : {}),
        dmPolicy: "disabled",
        allowFrom: [WHATSAPP_OWNER_NUMBER_E164],
        accounts: { work: { authDir: "/tmp/work" } },
      },
    },
  };
}

export function createWhatsAppAllowlistModeInput(): {
  selectValues: string[];
  textValues: string[];
} {
  return {
    selectValues: ["separate", "allowlist", "list"],
    textValues: [`${WHATSAPP_OWNER_NUMBER_INPUT}, ${WHATSAPP_OWNER_NUMBER}, *`],
  };
}

function expectWhatsAppDmAccess(
  cfg: WhatsAppSetupConfig,
  selfChatMode: boolean,
  dmPolicy: string,
  allowFrom?: string[],
): void {
  const whatsapp = cfg.channels?.whatsapp;
  expect([whatsapp?.selfChatMode, whatsapp?.dmPolicy, whatsapp?.allowFrom]).toEqual([
    selfChatMode,
    dmPolicy,
    allowFrom,
  ]);
}

export function expectWhatsAppWorkAccountOpenAccess(cfg: WhatsAppSetupConfig): void {
  expect(cfg.channels?.whatsapp).toMatchObject({
    dmPolicy: "disabled",
    allowFrom: [WHATSAPP_OWNER_NUMBER_E164],
    accounts: { work: { dmPolicy: "open", allowFrom: ["*", WHATSAPP_OWNER_NUMBER] } },
  });
}

export function expectWhatsAppOwnerAllowlistSetup(
  cfg: WhatsAppSetupConfig,
  harness: WizardPromptHarness,
): void {
  expectWhatsAppDmAccess(cfg, true, "allowlist", [WHATSAPP_OWNER_NUMBER]);
  expect(harness.text).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Your personal WhatsApp number (the phone you will message from)",
    }),
  );
}

export function expectWhatsAppSeparatePhoneDisabledSetup(
  cfg: WhatsAppSetupConfig,
  harness: WizardPromptHarness,
): void {
  expectWhatsAppDmAccess(cfg, false, "disabled");
  expect(harness.text).not.toHaveBeenCalled();
}

export function expectWhatsAppAllowlistModeSetup(cfg: WhatsAppSetupConfig): void {
  expectWhatsAppDmAccess(cfg, false, "allowlist", [WHATSAPP_OWNER_NUMBER, "*"]);
}

export function expectWhatsAppPersonalPhoneSetup(cfg: WhatsAppSetupConfig): void {
  expectWhatsAppDmAccess(cfg, true, "allowlist", ["15551112222"]);
}

export function expectWhatsAppOpenPolicySetup(
  cfg: WhatsAppSetupConfig,
  harness: WizardPromptHarness,
): void {
  expectWhatsAppDmAccess(cfg, false, "open", ["*", WHATSAPP_OWNER_NUMBER]);
  expect(harness.select).toHaveBeenCalledTimes(2);
  expect(harness.text).not.toHaveBeenCalled();
}

export function expectNoWhatsAppLoginFollowup(harness: WizardPromptHarness): void {
  expect(harness.note).not.toHaveBeenCalledWith(
    expect.stringContaining("openclaw channels login"),
    "WhatsApp",
  );
}

export function expectWhatsAppLoginFollowup(harness: WizardPromptHarness): void {
  expect(harness.note).toHaveBeenCalledWith(
    expect.stringContaining("openclaw channels login"),
    "WhatsApp",
  );
}

function expectAccountAccessNote(harness: WizardPromptHarness, account: string): void {
  const prefix = `channels.whatsapp.accounts.${account}`;
  expect(harness.note).toHaveBeenCalledWith(
    expect.stringContaining(`\`${prefix}.dmPolicy\` + \`${prefix}.allowFrom\``),
    "WhatsApp DM access",
  );
}

export function expectWhatsAppWorkAccountAccessNote(harness: WizardPromptHarness): void {
  expectAccountAccessNote(harness, "work");
}

export function expectWhatsAppDefaultAccountAccessNote(harness: WizardPromptHarness): void {
  expectAccountAccessNote(harness, "default");
}
