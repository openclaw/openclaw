import {
  createPluginSetupWizardConfigure,
  createPluginSetupWizardStatus,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { tlonPlugin } from "./channel.js";
import { tlonChannelConfigSchema } from "./config-schema.js";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";
import { tlonSetupWizard } from "./setup-surface.js";
import { resolveTlonOutboundTarget } from "./targets.js";
import { listTlonAccountIds, resolveTlonAccount } from "./types.js";

const tlonTestPlugin = {
  id: "tlon",
  meta: { label: "Tlon" },
  setupWizard: tlonSetupWizard,
  config: tlonPlugin.config,
  setup: {
    resolveAccountId: ({ accountId }: { cfg: OpenClawConfig; accountId?: string | null }) =>
      accountId ?? "default",
  },
};

const tlonConfigure = createPluginSetupWizardConfigure(tlonTestPlugin);
const tlonStatus = createPluginSetupWizardStatus(tlonTestPlugin);
const accountConfig = <T extends Record<string, unknown>>(tlon: T) => ({
  channels: { tlon },
});
const shipCredentials = {
  ship: "~sampel-palnet",
  url: "https://urbit.example.com",
  code: "lidlut-tabwed-pillex-ridrup",
};
const configure = (prompter: WizardPrompter, cfg: OpenClawConfig = {}) =>
  runSetupWizardConfigure({ configure: tlonConfigure, cfg, prompter, options: {} });
function promptText(answers: Record<string, string>) {
  const byMessage = new Map(Object.entries(answers));
  return vi.fn(async ({ message }: { message: string }) => {
    const answer = byMessage.get(message);
    if (answer === undefined) {
      throw new Error(`Unexpected prompt: ${message}`);
    }
    return answer;
  });
}

describe("tlon core", () => {
  it("formats dm allowlist entries through the shared hybrid adapter", () => {
    expect(
      tlonTestPlugin.config.formatAllowFrom?.({
        cfg: {},
        allowFrom: ["zod", " ~nec "],
      }),
    ).toEqual(["~zod", "~nec"]);
  });

  it("resolves dm allowlist from the default account", () => {
    expect(
      tlonTestPlugin.config.resolveAllowFrom?.({
        cfg: accountConfig({ ...shipCredentials, dmAllowlist: ["~zod"] }),
        accountId: "default",
      }),
    ).toEqual(["~zod"]);
  });

  it("preserves mention policy at root and account scope", () => {
    expect(
      tlonChannelConfigSchema.runtime?.safeParse({
        implicitMentions: { threadParticipation: false },
        requireMentionInBotThreads: true,
        accounts: {
          primary: {
            implicitMentions: { replyToBot: false },
            requireMentionInBotThreads: false,
          },
        },
      }),
    ).toMatchObject({
      success: true,
      data: {
        requireMentionInBotThreads: true,
        accounts: { primary: { requireMentionInBotThreads: false } },
      },
    });
  });

  it("configures ship, auth, and discovery settings", async () => {
    const answers: Record<string, string> = {
      "Ship name": "sampel-palnet",
      "Ship URL": shipCredentials.url,
      "Login code": shipCredentials.code,
      "Group channels (comma-separated)": "chat/~host-ship/general, chat/~host-ship/support",
      "DM allowlist (comma-separated ship names)": "~zod, nec",
    };
    const prompter = createTestWizardPrompter({
      text: promptText(answers) as WizardPrompter["text"],
      confirm: vi.fn(async ({ message }: { message: string }) =>
        [
          "Add group channels manually? (optional)",
          "Restrict DMs with an allowlist?",
          "Enable auto-discovery of group channels?",
        ].includes(message),
      ),
    });

    const result = await configure(prompter);

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.tlon).toMatchObject({
      ...shipCredentials,
      enabled: true,
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
      dmAllowlist: ["~zod", "~nec"],
      autoDiscoverChannels: true,
      network: { dangerouslyAllowPrivateNetwork: false },
    });
  });

  it("never sends an existing login code back through setup prompts", async () => {
    const existingCode = "lidlut-existing-secret-code";
    const text = promptText({ "Login code": "lidlut-replacement-code" });
    const confirm = vi.fn(
      async ({ message }: { message: string }) =>
        message.startsWith("Ship name") ||
        message.startsWith("Ship URL") ||
        message === "Enable auto-discovery of group channels?",
    );
    const prompter = createTestWizardPrompter({
      text: text as WizardPrompter["text"],
      confirm,
    });

    const result = await configure(
      prompter,
      accountConfig({ ...shipCredentials, code: existingCode }),
    );

    expect(result.cfg.channels?.tlon?.code).toBe("lidlut-replacement-code");
    expect(JSON.stringify({ confirms: confirm.mock.calls, texts: text.mock.calls })).not.toContain(
      existingCode,
    );
    const codePrompt = text.mock.calls.find(([args]) => args.message === "Login code")?.[0];
    expect(codePrompt).toMatchObject({ sensitive: true });
    expect(codePrompt).not.toHaveProperty("initialValue");
  });

  it.each([
    ["dm/sampel-palnet", "~sampel-palnet"],
    ["group:host-ship/general", "chat/~host-ship/general"],
  ])("normalizes target %s", (target, to) => {
    expect(resolveTlonOutboundTarget(target)).toEqual({ ok: true, to });
  });

  it("returns a helpful error for invalid targets", () => {
    expect(resolveTlonOutboundTarget("group:bad-target")).toMatchObject({
      ok: false,
      error: { message: expect.stringMatching(/invalid tlon target/i) },
    });
  });

  it("lists named accounts and the implicit default account", () => {
    const cfg = accountConfig({
      ship: "~zod",
      accounts: { Work: { ship: "~bus" }, alerts: { ship: "~nec" } },
    });

    expect(listTlonAccountIds(cfg)).toEqual(["alerts", "default", "work"]);
  });

  it("requires Doctor for private-network aliases", () => {
    const cfg = accountConfig({
      ship: "~zod",
      allowPrivateNetwork: true,
      network: { dangerouslyAllowPrivateNetwork: undefined },
    });

    expect(resolveTlonAccount(cfg).dangerouslyAllowPrivateNetwork).toBe(null);
    const repaired = normalizeCompatibilityConfig({ cfg });
    expect(resolveTlonAccount(repaired.config).dangerouslyAllowPrivateNetwork).toBe(true);
  });

  it("setup status labels the selected account", async () => {
    const status = await tlonStatus({
      cfg: accountConfig({
        ...shipCredentials,
        ship: "~zod",
        code: "base-code",
        accounts: { work: {} },
      }),
      accountOverrides: { tlon: "work" },
    });

    expect(status).toMatchObject({ configured: true, statusLines: ["Tlon (work): configured"] });
  });
});
