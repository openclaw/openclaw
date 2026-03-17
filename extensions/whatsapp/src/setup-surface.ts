import path from "node:path";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeAllowFromEntries,
  normalizeE164,
  pathExists,
  splitSetupEntries,
  setSetupChannelEnabled,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/setup";
import { formatCliCommand } from "../../../src/cli/command-format.js";
import type { DmPolicy } from "../../../src/config/types.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import { listWhatsAppAccountIds, resolveWhatsAppAuthDir } from "./accounts.js";
import { loginWeb } from "./login.js";
import { whatsappSetupAdapter } from "./setup-core.js";

const channel = "whatsapp" as const;

function mergeWhatsAppConfig(
  cfg: OpenClawConfig,
  patch: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>>,
  options?: { unsetOnUndefined?: string[] },
): OpenClawConfig {
  const base = { ...(cfg.channels?.whatsapp ?? {}) } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      if (options?.unsetOnUndefined?.includes(key)) {
        delete base[key];
      }
      continue;
    }
    base[key] = value;
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      whatsapp: base,
    },
  };
}

function setWhatsAppDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  return mergeWhatsAppConfig(cfg, { dmPolicy });
}

function setWhatsAppAllowFrom(cfg: OpenClawConfig, allowFrom?: string[]): OpenClawConfig {
  return mergeWhatsAppConfig(cfg, { allowFrom }, { unsetOnUndefined: ["allowFrom"] });
}

function setWhatsAppSelfChatMode(cfg: OpenClawConfig, selfChatMode: boolean): OpenClawConfig {
  return mergeWhatsAppConfig(cfg, { selfChatMode });
}

async function detectWhatsAppLinked(cfg: OpenClawConfig, accountId: string): Promise<boolean> {
  const { authDir } = resolveWhatsAppAuthDir({ cfg, accountId });
  const credsPath = path.join(authDir, "creds.json");
  return await pathExists(credsPath);
}

async function promptWhatsAppOwnerAllowFrom(params: {
  existingAllowFrom: string[];
  prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];
}): Promise<{ normalized: string; allowFrom: string[] }> {
  const { prompter, existingAllowFrom } = params;

  await prompter.note(
    "We need the sender/owner number so OpenClaw can allowlist you.",
    "WhatsApp number",
  );
  const entry = await prompter.text({
    message: "Your personal WhatsApp number (the phone you will message from)",
    placeholder: "+15555550123",
    initialValue: existingAllowFrom[0],
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      const normalized = normalizeE164(raw);
      if (!normalized) {
        return `Invalid number: ${raw}`;
      }
      return undefined;
    },
  });

  const normalized = normalizeE164(String(entry).trim());
  if (!normalized) {
    throw new Error("Invalid WhatsApp owner number (expected E.164 after validation).");
  }
  const allowFrom = normalizeAllowFromEntries(
    [...existingAllowFrom.filter((item) => item !== "*"), normalized],
    normalizeE164,
  );
  return { normalized, allowFrom };
}

async function applyWhatsAppOwnerAllowlist(params: {
  cfg: OpenClawConfig;
  existingAllowFrom: string[];
  messageLines: string[];
  prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];
  title: string;
}): Promise<OpenClawConfig> {
  const { normalized, allowFrom } = await promptWhatsAppOwnerAllowFrom({
    prompter: params.prompter,
    existingAllowFrom: params.existingAllowFrom,
  });
  let next = setWhatsAppSelfChatMode(params.cfg, true);
  next = setWhatsAppDmPolicy(next, "allowlist");
  next = setWhatsAppAllowFrom(next, allowFrom);
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
    const normalized = normalizeE164(part);
    if (!normalized) {
      return { entries: [], invalidEntry: part };
    }
    entries.push(normalized);
  }
  return { entries: normalizeAllowFromEntries(entries, normalizeE164) };
}

async function promptWhatsAppDmAccess(params: {
  cfg: OpenClawConfig;
  forceAllowFrom: boolean;
  prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];
}): Promise<OpenClawConfig> {
  const existingPolicy = params.cfg.channels?.whatsapp?.dmPolicy ?? "pairing";
  const existingAllowFrom = params.cfg.channels?.whatsapp?.allowFrom ?? [];
  const existingLabel = existingAllowFrom.length > 0 ? existingAllowFrom.join(", ") : "unset";

  if (params.forceAllowFrom) {
    return await applyWhatsAppOwnerAllowlist({
      cfg: params.cfg,
      prompter: params.prompter,
      existingAllowFrom,
      title: "WhatsApp allowlist",
      messageLines: ["Allowlist mode enabled."],
    });
  }

  await params.prompter.note(
    [
      "WhatsApp direct chats are gated by `channels.whatsapp.dmPolicy` + `channels.whatsapp.allowFrom`.",
      "- pairing (default): unknown senders get a pairing code; owner approves",
      "- allowlist: unknown senders are blocked",
      '- open: public inbound DMs (requires allowFrom to include "*")',
      "- disabled: ignore WhatsApp DMs",
      "",
      `Current: dmPolicy=${existingPolicy}, allowFrom=${existingLabel}`,
      `Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`,
    ].join("\n"),
    "WhatsApp DM access",
  );

  const phoneMode = await params.prompter.select({
    message: "WhatsApp phone setup",
    options: [
      { value: "personal", label: "This is my personal phone number" },
      { value: "separate", label: "Separate phone just for OpenClaw" },
    ],
  });

  if (phoneMode === "personal") {
    return await applyWhatsAppOwnerAllowlist({
      cfg: params.cfg,
      prompter: params.prompter,
      existingAllowFrom,
      title: "WhatsApp personal phone",
      messageLines: [
        "Personal phone mode enabled.",
        "- dmPolicy set to allowlist (pairing skipped)",
      ],
    });
  }

  const policy = (await params.prompter.select({
    message: "WhatsApp DM policy",
    options: [
      { value: "pairing", label: "Pairing (recommended)" },
      { value: "allowlist", label: "Allowlist only (block unknown senders)" },
      { value: "open", label: "Open (public inbound DMs)" },
      { value: "disabled", label: "Disabled (ignore WhatsApp DMs)" },
    ],
  })) as DmPolicy;

  let next = setWhatsAppSelfChatMode(params.cfg, false);
  next = setWhatsAppDmPolicy(next, policy);
  if (policy === "open") {
    const allowFrom = normalizeAllowFromEntries(["*", ...existingAllowFrom], normalizeE164);
    next = setWhatsAppAllowFrom(next, allowFrom.length > 0 ? allowFrom : ["*"]);
    return next;
  }
  if (policy === "disabled") {
    return next;
  }

  const allowOptions =
    existingAllowFrom.length > 0
      ? ([
          { value: "keep", label: "Keep current allowFrom" },
          {
            value: "unset",
            label: "Unset allowFrom (use pairing approvals only)",
          },
          { value: "list", label: "Set allowFrom to specific numbers" },
        ] as const)
      : ([
          { value: "unset", label: "Unset allowFrom (default)" },
          { value: "list", label: "Set allowFrom to specific numbers" },
        ] as const);

  const mode = await params.prompter.select({
    message: "WhatsApp allowFrom (optional pre-allowlist)",
    options: allowOptions.map((opt) => ({
      value: opt.value,
      label: opt.label,
    })),
  });

  if (mode === "keep") {
    return next;
  }
  if (mode === "unset") {
    return setWhatsAppAllowFrom(next, undefined);
  }

  const allowRaw = await params.prompter.text({
    message: "Allowed sender numbers (comma-separated, E.164)",
    placeholder: "+15555550123, +447700900123",
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      const parsed = parseWhatsAppAllowFromEntries(raw);
      if (parsed.entries.length === 0 && !parsed.invalidEntry) {
        return "Required";
      }
      if (parsed.invalidEntry) {
        return `Invalid number: ${parsed.invalidEntry}`;
      }
      return undefined;
    },
  });

  const parsed = parseWhatsAppAllowFromEntries(String(allowRaw));
  return setWhatsAppAllowFrom(next, parsed.entries);
}

export const whatsappSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "linked",
    unconfiguredLabel: "not linked",
    configuredHint: "linked",
    unconfiguredHint: "not linked",
    configuredScore: 5,
    unconfiguredScore: 4,
    resolveConfigured: async ({ cfg }) => {
      for (const accountId of listWhatsAppAccountIds(cfg)) {
        if (await detectWhatsAppLinked(cfg, accountId)) {
          return true;
        }
      }
      return false;
    },
    resolveStatusLines: async ({ cfg, configured }) => {
      const linkedAccountId = (
        await Promise.all(
          listWhatsAppAccountIds(cfg).map(async (accountId) => ({
            accountId,
            linked: await detectWhatsAppLinked(cfg, accountId),
          })),
        )
      ).find((entry) => entry.linked)?.accountId;
      const label = linkedAccountId
        ? `WhatsApp (${linkedAccountId === DEFAULT_ACCOUNT_ID ? "default" : linkedAccountId})`
        : "WhatsApp";
      return [`${label}: ${configured ? "linked" : "not linked"}`];
    },
  },
  resolveShouldPromptAccountIds: ({ options, shouldPromptAccountIds }) =>
    Boolean(shouldPromptAccountIds || options?.promptWhatsAppAccountId),
  credentials: [],
  finalize: async ({ cfg, accountId, forceAllowFrom, prompter, runtime }) => {
    let next =
      accountId === DEFAULT_ACCOUNT_ID
        ? cfg
        : whatsappSetupAdapter.applyAccountConfig({
            cfg,
            accountId,
            input: {},
          });

    const linked = await detectWhatsAppLinked(next, accountId);
    const { authDir } = resolveWhatsAppAuthDir({
      cfg: next,
      accountId,
    });

    if (!linked) {
      await prompter.note(
        [
          "Scan the QR with WhatsApp on your phone.",
          `Credentials are stored under ${authDir}/ for future runs.`,
          `Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`,
        ].join("\n"),
        "WhatsApp linking",
      );
    }

    const wantsLink = await prompter.confirm({
      message: linked ? "WhatsApp already linked. Re-link now?" : "Link WhatsApp now (QR)?",
      initialValue: !linked,
    });
    if (wantsLink) {
      try {
        await loginWeb(false, undefined, runtime, accountId);
      } catch (error) {
        runtime.error(`WhatsApp login failed: ${String(error)}`);
        await prompter.note(`Docs: ${formatDocsLink("/whatsapp", "whatsapp")}`, "WhatsApp help");
      }
    } else if (!linked) {
      await prompter.note(
        `Run \`${formatCliCommand("openclaw channels login")}\` later to link WhatsApp.`,
        "WhatsApp",
      );
    }

    next = await promptWhatsAppDmAccess({
      cfg: next,
      forceAllowFrom,
      prompter,
    });
    return { cfg: next };
  },
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
  onAccountRecorded: (accountId, options) => {
    options?.onWhatsAppAccountId?.(accountId);
  },
};
