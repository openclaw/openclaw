import {
  DEFAULT_ACCOUNT_ID,
  splitSetupEntries,
  createSetupTranslator,
  type ChannelSetupWizard,
  type DmPolicy,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import type { WhatsAppAccountConfig } from "./account-types.js";
import {
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
  resolveWhatsAppAuthDir,
} from "./accounts.js";
import { hasWebCredsSync } from "./creds-files.js";
import {
  normalizeWhatsAppAllowFromEntries,
  normalizeWhatsAppAllowFromEntry,
} from "./normalize-target.js";
import { whatsappSetupAdapter } from "./setup-core.js";

const t = createSetupTranslator();

type SetupPrompter = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];
type SetupRuntime = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["runtime"];
type WhatsAppConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>;

function trimPromptText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function isDefaultWhatsAppAccountKey(accountId: string): boolean {
  return accountId.trim().toLowerCase() === DEFAULT_ACCOUNT_ID;
}

function resolveWhatsAppAccountWriteKey(
  cfg: OpenClawConfig,
  accountId: string,
): string | undefined {
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    return accountId;
  }
  const accounts = cfg.channels?.whatsapp?.accounts;
  const keys = Object.keys(accounts ?? {});
  if (!accounts?.default && !keys.some((key) => !isDefaultWhatsAppAccountKey(key))) {
    return undefined;
  }
  return keys.find(isDefaultWhatsAppAccountKey) ?? DEFAULT_ACCOUNT_ID;
}

function resolveWhatsAppConfigPathPrefix(cfg: OpenClawConfig, accountId: string): string {
  const key = resolveWhatsAppAccountWriteKey(cfg, accountId);
  return key === undefined ? "channels.whatsapp" : `channels.whatsapp.accounts.${key}`;
}

function mergeWhatsAppConfig(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Partial<WhatsAppAccountConfig>,
  options?: { unsetOnUndefined?: string[] },
): OpenClawConfig {
  const channelConfig: WhatsAppConfig = { ...cfg.channels?.whatsapp };
  const targetAccountId = resolveWhatsAppAccountWriteKey(cfg, accountId);
  const atRoot = targetAccountId === undefined;
  const accounts = { ...channelConfig.accounts };
  const lowerDefaultAccount =
    accountId === DEFAULT_ACCOUNT_ID && targetAccountId !== DEFAULT_ACCOUNT_ID
      ? accounts[DEFAULT_ACCOUNT_ID]
      : undefined;
  const target: WhatsAppAccountConfig = atRoot
    ? channelConfig
    : { ...accounts[targetAccountId], ...lowerDefaultAccount };
  const mutableTarget = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      if (options?.unsetOnUndefined?.includes(key)) {
        delete mutableTarget[key];
      }
      continue;
    }
    mutableTarget[key] = value;
  }
  if (!atRoot) {
    accounts[targetAccountId] = target;
    if (lowerDefaultAccount) {
      delete accounts[DEFAULT_ACCOUNT_ID];
    }
    channelConfig.accounts = accounts;
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      whatsapp: channelConfig,
    },
  };
}

function setWhatsAppAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom?: string[],
): OpenClawConfig {
  return mergeWhatsAppConfig(cfg, accountId, { allowFrom }, { unsetOnUndefined: ["allowFrom"] });
}

function parseWhatsAppAllowFromEntries(raw: string): { entries: string[]; invalidEntry?: string } {
  const entries: string[] = [];
  for (const part of splitSetupEntries(raw)) {
    const normalized = normalizeWhatsAppAllowFromEntry(part);
    if (!normalized) {
      return { entries: [], invalidEntry: part };
    }
    entries.push(normalized);
  }
  return { entries: normalizeWhatsAppAllowFromEntries(entries) };
}

export async function finalizeWhatsAppSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  forceAllowFrom: boolean;
  prompter: SetupPrompter;
  runtime: SetupRuntime;
  options?: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["options"];
}) {
  const selectedAccountId = params.accountId.trim() || resolveDefaultWhatsAppAccountId(params.cfg);
  let next =
    selectedAccountId === DEFAULT_ACCOUNT_ID
      ? params.cfg
      : whatsappSetupAdapter.applyAccountConfig({
          cfg: params.cfg,
          accountId: selectedAccountId,
          input: {},
        });

  const { authDir } = resolveWhatsAppAuthDir({ cfg: next, accountId: selectedAccountId });
  const linked = hasWebCredsSync(authDir);

  // Gateway clients render their own pairing QR; only terminal setup runs login here.
  if (!params.options?.deferDeviceLinkToClient) {
    if (!linked) {
      await params.prompter.note(
        [
          t("wizard.whatsapp.scanQr"),
          t("wizard.whatsapp.credentialsStored", { authDir }),
          t("wizard.channels.docs", { link: formatDocsLink("/whatsapp", "whatsapp") }),
        ].join("\n"),
        t("wizard.whatsapp.linkingTitle"),
      );
    }

    const wantsLink = await params.prompter.confirm({
      message: linked ? t("wizard.whatsapp.relinkPrompt") : t("wizard.whatsapp.linkNowPrompt"),
      initialValue: !linked,
    });
    if (wantsLink) {
      let persistenceGuardFailure: { error: unknown } | undefined;
      try {
        const { loginWeb } = await import("./login.js");
        const beforeCredentialPersistence = params.options?.beforePersistentEffect
          ? async () => {
              try {
                await params.options?.beforePersistentEffect?.();
              } catch (error) {
                persistenceGuardFailure = { error };
                throw error;
              }
            }
          : undefined;
        await loginWeb(false, undefined, params.runtime, selectedAccountId, {
          beforeCredentialPersistence,
        });
      } catch (error) {
        if (persistenceGuardFailure) {
          throw persistenceGuardFailure.error;
        }
        params.runtime.error(`WhatsApp login failed: ${String(error)}`);
        await params.prompter.note(
          t("wizard.channels.docs", { link: formatDocsLink("/whatsapp", "whatsapp") }),
          t("wizard.whatsapp.helpTitle"),
        );
      }
    } else if (!linked) {
      await params.prompter.note(
        t("wizard.whatsapp.linkLater", {
          command: formatCliCommand("openclaw channels login"),
        }),
        "WhatsApp",
      );
    }
  }

  const cfg = next;
  const { forceAllowFrom, prompter } = params;
  async function promptWhatsAppDmAccess(): Promise<OpenClawConfig> {
    const accountId = selectedAccountId.trim() || DEFAULT_ACCOUNT_ID;
    const account = resolveWhatsAppAccount({ cfg, accountId });
    const existingPolicy = account.dmPolicy ?? "pairing";
    const existingAllowFrom = account.allowFrom ?? [];
    const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";
    const configPathPrefix = resolveWhatsAppConfigPathPrefix(cfg, accountId);
    const policyKey = `${configPathPrefix}.dmPolicy`;
    const allowFromKey = `${configPathPrefix}.allowFrom`;

    async function applyWhatsAppOwnerAllowlist(
      title: string,
      messageLines: string[],
    ): Promise<OpenClawConfig> {
      await prompter.note(t("wizard.whatsapp.ownerNumberNote"), t("wizard.whatsapp.numberTitle"));
      const entry = await prompter.text({
        message: t("wizard.whatsapp.personalNumberPrompt"),
        placeholder: "+15555550123",
        initialValue: existingAllowFrom[0],
        validate: (value) => {
          const raw = trimPromptText(value);
          if (!raw) {
            return t("common.required");
          }
          const normalized = normalizeWhatsAppAllowFromEntry(raw);
          if (!normalized) {
            return `Invalid number: ${raw}`;
          }
          return undefined;
        },
      });

      const normalized = normalizeWhatsAppAllowFromEntry(trimPromptText(entry));
      if (!normalized) {
        throw new Error("Invalid WhatsApp owner number (expected E.164 after validation).");
      }
      const allowFrom = normalizeWhatsAppAllowFromEntries([
        ...existingAllowFrom.filter((item) => item !== "*"),
        normalized,
      ]);
      const ownerConfig = mergeWhatsAppConfig(cfg, accountId, {
        selfChatMode: true,
        dmPolicy: "allowlist",
        allowFrom,
      });
      await prompter.note(
        [...messageLines, `- allowFrom includes ${normalized}`].join("\n"),
        title,
      );
      return ownerConfig;
    }

    if (forceAllowFrom) {
      return await applyWhatsAppOwnerAllowlist(t("wizard.whatsapp.allowlistTitle"), [
        t("wizard.whatsapp.allowlistModeEnabled"),
      ]);
    }

    await prompter.note(
      [
        `WhatsApp direct chats are gated by \`${policyKey}\` + \`${allowFromKey}\`.`,
        "- pairing (default): unknown senders get a pairing code; owner approves",
        "- allowlist: unknown senders are blocked",
        '- open: public inbound DMs (requires allowFrom to include "*")',
        "- disabled: ignore WhatsApp DMs",
        "",
        `Current: dmPolicy=${existingPolicy}, allowFrom=${existingLabel}`,
        t("wizard.channels.docs", { link: formatDocsLink("/whatsapp", "whatsapp") }),
      ].join("\n"),
      t("wizard.whatsapp.dmAccessTitle"),
    );

    const phoneMode = await prompter.select({
      message: t("wizard.whatsapp.phoneSetupPrompt"),
      options: [
        { value: "personal", label: t("wizard.whatsapp.personalPhoneLabel") },
        { value: "separate", label: t("wizard.whatsapp.separatePhoneLabel") },
      ],
    });

    if (phoneMode === "personal") {
      return await applyWhatsAppOwnerAllowlist(t("wizard.whatsapp.personalPhoneTitle"), [
        t("wizard.whatsapp.personalPhoneModeEnabled"),
        t("wizard.whatsapp.dmPolicySetAllowlist"),
      ]);
    }

    const policy = (await prompter.select({
      message: t("wizard.whatsapp.dmPolicyPrompt"),
      options: [
        { value: "pairing", label: t("wizard.channels.dmPolicyPairing") },
        { value: "allowlist", label: t("wizard.whatsapp.dmPolicyAllowlistOnly") },
        { value: "open", label: t("wizard.channels.dmPolicyOpenOption") },
        { value: "disabled", label: t("wizard.whatsapp.dmPolicyDisabled") },
      ],
    })) as DmPolicy;

    const accessConfig = mergeWhatsAppConfig(cfg, accountId, {
      selfChatMode: false,
      dmPolicy: policy,
    });
    if (policy === "open") {
      const allowFrom = normalizeWhatsAppAllowFromEntries(["*", ...existingAllowFrom]);
      return setWhatsAppAllowFrom(accessConfig, accountId, allowFrom);
    }
    if (policy === "disabled") {
      return accessConfig;
    }

    const mode = await prompter.select({
      message: t("wizard.whatsapp.allowFromPrompt"),
      options: [
        ...(existingAllowFrom.length > 0
          ? [{ value: "keep", label: t("wizard.whatsapp.keepCurrentAllowFrom") }]
          : []),
        {
          value: "unset",
          label: t(
            existingAllowFrom.length > 0
              ? "wizard.whatsapp.unsetAllowFromPairing"
              : "wizard.whatsapp.unsetAllowFromDefault",
          ),
        },
        { value: "list", label: t("wizard.whatsapp.setAllowFromNumbers") },
      ],
    });

    if (mode === "keep") {
      return accessConfig;
    }
    if (mode === "unset") {
      return setWhatsAppAllowFrom(accessConfig, accountId, undefined);
    }

    const allowRaw = await prompter.text({
      message: t("wizard.whatsapp.allowedSenderNumbers"),
      placeholder: "+15555550123, +447700900123",
      validate: (value) => {
        const raw = trimPromptText(value);
        if (!raw) {
          return t("common.required");
        }
        const parsed = parseWhatsAppAllowFromEntries(raw);
        if (parsed.entries.length === 0 && !parsed.invalidEntry) {
          return t("common.required");
        }
        if (parsed.invalidEntry) {
          return `Invalid number: ${parsed.invalidEntry}`;
        }
        return undefined;
      },
    });

    const parsed = parseWhatsAppAllowFromEntries(trimPromptText(allowRaw));
    if (parsed.invalidEntry) {
      throw new Error(`Invalid number: ${parsed.invalidEntry}`);
    }
    if (parsed.entries.length === 0) {
      throw new Error("Invalid WhatsApp allowFrom list (expected at least one E.164 number).");
    }
    return setWhatsAppAllowFrom(accessConfig, accountId, parsed.entries);
  }
  next = await promptWhatsAppDmAccess();
  return { cfg: next };
}
