import {
  DEFAULT_ACCOUNT_ID,
  splitSetupEntries,
  createSetupTranslator,
  type ChannelSetupWizard,
  type DmPolicy,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
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
type WhatsAppAccountConfig = NonNullable<NonNullable<WhatsAppConfig["accounts"]>[string]>;

function trimPromptText(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function isDefaultWhatsAppAccountKey(accountId: string): boolean {
  return accountId.trim().toLowerCase() === DEFAULT_ACCOUNT_ID;
}

function shouldWriteDefaultWhatsAppAccountConfigAtAccountScope(cfg: OpenClawConfig): boolean {
  const accounts = cfg.channels?.whatsapp?.accounts;
  if (!accounts) {
    return false;
  }
  if (accounts.default) {
    return true;
  }
  return Object.keys(accounts).some((accountId) => !isDefaultWhatsAppAccountKey(accountId));
}

function resolveDefaultWhatsAppAccountWriteKey(cfg: OpenClawConfig): string {
  const accounts = cfg.channels?.whatsapp?.accounts;
  if (!accounts) {
    return DEFAULT_ACCOUNT_ID;
  }
  const match = Object.keys(accounts).find((accountId) => isDefaultWhatsAppAccountKey(accountId));
  return match ?? DEFAULT_ACCOUNT_ID;
}

function resolveWhatsAppConfigPathPrefix(cfg: OpenClawConfig, accountId: string): string {
  if (
    accountId === DEFAULT_ACCOUNT_ID &&
    shouldWriteDefaultWhatsAppAccountConfigAtAccountScope(cfg)
  ) {
    return `channels.whatsapp.accounts.${resolveDefaultWhatsAppAccountWriteKey(cfg)}`;
  }
  return accountId === DEFAULT_ACCOUNT_ID
    ? "channels.whatsapp"
    : `channels.whatsapp.accounts.${accountId}`;
}

function mergeWhatsAppConfig(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Partial<WhatsAppAccountConfig>,
  options?: { unsetOnUndefined?: string[] },
): OpenClawConfig {
  const channelConfig: WhatsAppConfig = { ...cfg.channels?.whatsapp };
  const atRoot = resolveWhatsAppConfigPathPrefix(cfg, accountId) === "channels.whatsapp";
  const accounts = { ...channelConfig.accounts };
  const targetAccountId =
    accountId === DEFAULT_ACCOUNT_ID ? resolveDefaultWhatsAppAccountWriteKey(cfg) : accountId;
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

async function promptWhatsAppOwnerAllowFrom(params: {
  existingAllowFrom: string[];
  prompter: SetupPrompter;
}): Promise<{ normalized: string; allowFrom: string[] }> {
  const { prompter, existingAllowFrom } = params;

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
  return { normalized, allowFrom };
}

async function applyWhatsAppOwnerAllowlist(params: {
  cfg: OpenClawConfig;
  accountId: string;
  existingAllowFrom: string[];
  messageLines: string[];
  prompter: SetupPrompter;
  title: string;
}): Promise<OpenClawConfig> {
  const { normalized, allowFrom } = await promptWhatsAppOwnerAllowFrom({
    prompter: params.prompter,
    existingAllowFrom: params.existingAllowFrom,
  });
  const next = mergeWhatsAppConfig(params.cfg, params.accountId, {
    selfChatMode: true,
    dmPolicy: "allowlist",
    allowFrom,
  });
  await params.prompter.note(
    [...params.messageLines, `- allowFrom includes ${normalized}`].join("\n"),
    params.title,
  );
  return next;
}

function parseWhatsAppAllowFromEntries(raw: string): { entries: string[]; invalidEntry?: string } {
  const parts = splitSetupEntries(raw);
  if (parts.length === 0) {
    return { entries: [] };
  }
  const entries: string[] = [];
  for (const part of parts) {
    if (part === "*") {
      entries.push("*");
      continue;
    }
    const normalized = normalizeWhatsAppAllowFromEntry(part);
    if (!normalized) {
      return { entries: [], invalidEntry: part };
    }
    entries.push(normalized);
  }
  return { entries: normalizeWhatsAppAllowFromEntries(entries) };
}

async function promptWhatsAppDmAccess(params: {
  cfg: OpenClawConfig;
  accountId: string;
  forceAllowFrom: boolean;
  prompter: SetupPrompter;
}): Promise<OpenClawConfig> {
  const accountId = params.accountId.trim() || DEFAULT_ACCOUNT_ID;
  const account = resolveWhatsAppAccount({ cfg: params.cfg, accountId });
  const existingPolicy = account.dmPolicy ?? "pairing";
  const existingAllowFrom = account.allowFrom ?? [];
  const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";
  const configPathPrefix = resolveWhatsAppConfigPathPrefix(params.cfg, accountId);
  const policyKey = `${configPathPrefix}.dmPolicy`;
  const allowFromKey = `${configPathPrefix}.allowFrom`;

  if (params.forceAllowFrom) {
    return await applyWhatsAppOwnerAllowlist({
      cfg: params.cfg,
      accountId,
      prompter: params.prompter,
      existingAllowFrom,
      title: t("wizard.whatsapp.allowlistTitle"),
      messageLines: [t("wizard.whatsapp.allowlistModeEnabled")],
    });
  }

  await params.prompter.note(
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

  const phoneMode = await params.prompter.select({
    message: t("wizard.whatsapp.phoneSetupPrompt"),
    options: [
      { value: "personal", label: t("wizard.whatsapp.personalPhoneLabel") },
      { value: "separate", label: t("wizard.whatsapp.separatePhoneLabel") },
    ],
  });

  if (phoneMode === "personal") {
    return await applyWhatsAppOwnerAllowlist({
      cfg: params.cfg,
      accountId,
      prompter: params.prompter,
      existingAllowFrom,
      title: t("wizard.whatsapp.personalPhoneTitle"),
      messageLines: [
        t("wizard.whatsapp.personalPhoneModeEnabled"),
        t("wizard.whatsapp.dmPolicySetAllowlist"),
      ],
    });
  }

  const policy = (await params.prompter.select({
    message: t("wizard.whatsapp.dmPolicyPrompt"),
    options: [
      { value: "pairing", label: t("wizard.channels.dmPolicyPairing") },
      { value: "allowlist", label: t("wizard.whatsapp.dmPolicyAllowlistOnly") },
      { value: "open", label: t("wizard.channels.dmPolicyOpenOption") },
      { value: "disabled", label: t("wizard.whatsapp.dmPolicyDisabled") },
    ],
  })) as DmPolicy;

  let next = mergeWhatsAppConfig(params.cfg, accountId, {
    selfChatMode: false,
    dmPolicy: policy,
  });
  if (policy === "open") {
    const allowFrom = normalizeWhatsAppAllowFromEntries(["*", ...existingAllowFrom]);
    next = setWhatsAppAllowFrom(next, accountId, allowFrom.length > 0 ? allowFrom : ["*"]);
    return next;
  }
  if (policy === "disabled") {
    return next;
  }

  const allowOptions =
    existingAllowFrom.length > 0
      ? ([
          { value: "keep", label: t("wizard.whatsapp.keepCurrentAllowFrom") },
          {
            value: "unset",
            label: t("wizard.whatsapp.unsetAllowFromPairing"),
          },
          { value: "list", label: t("wizard.whatsapp.setAllowFromNumbers") },
        ] as const)
      : ([
          { value: "unset", label: t("wizard.whatsapp.unsetAllowFromDefault") },
          { value: "list", label: t("wizard.whatsapp.setAllowFromNumbers") },
        ] as const);

  const mode = await params.prompter.select({
    message: t("wizard.whatsapp.allowFromPrompt"),
    options: [...allowOptions],
  });

  if (mode === "keep") {
    return next;
  }
  if (mode === "unset") {
    return setWhatsAppAllowFrom(next, accountId, undefined);
  }

  const allowRaw = await params.prompter.text({
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
  return setWhatsAppAllowFrom(next, accountId, parsed.entries);
}

export async function finalizeWhatsAppSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  forceAllowFrom: boolean;
  prompter: SetupPrompter;
  runtime: SetupRuntime;
  options?: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["options"];
}) {
  const accountId = params.accountId.trim() || resolveDefaultWhatsAppAccountId(params.cfg);
  let next =
    accountId === DEFAULT_ACCOUNT_ID
      ? params.cfg
      : whatsappSetupAdapter.applyAccountConfig({
          cfg: params.cfg,
          accountId,
          input: {},
        });

  const { authDir } = resolveWhatsAppAuthDir({ cfg: next, accountId });
  const linked = hasWebCredsSync(authDir);

  if (params.options?.deferDeviceLinkToClient) {
    // The gateway client renders the pairing QR itself (web.login.start/wait);
    // running the terminal QR login here would print to a headless process.
    next = await promptWhatsAppDmAccess({
      cfg: next,
      accountId,
      forceAllowFrom: params.forceAllowFrom,
      prompter: params.prompter,
    });
    return { cfg: next };
  }

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
      await loginWeb(false, undefined, params.runtime, accountId, {
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

  next = await promptWhatsAppDmAccess({
    cfg: next,
    accountId,
    forceAllowFrom: params.forceAllowFrom,
    prompter: params.prompter,
  });
  return { cfg: next };
}
