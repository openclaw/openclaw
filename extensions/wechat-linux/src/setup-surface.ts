import {
  createAllowFromSection,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  normalizeAccountId,
  parseSetupEntriesAllowingWildcard,
  promptParsedAllowFromForAccount,
  type ChannelSetupDmPolicy,
  type ChannelSetupInput,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { listWechatLinuxAccountIds, resolveWechatLinuxAccount } from "./accounts.js";
import { normalizeWechatLinuxAllowEntry } from "./normalize.js";
import {
  patchWechatLinuxAccountConfig,
  setWechatLinuxAllowFrom,
  setWechatLinuxGroupAccess,
} from "./setup-core.js";
import type { CoreConfig, GroupPolicy } from "./types.js";

const channel = "wechat-linux" as const;

const SETUP_HELP_LINES = [
  "1) Install and verify the official Linux WeChat desktop client",
  "2) Clone PyWxDump on the same machine and point OpenClaw at that repo root",
  "3) Extract ~/.wx_db_keys.json and confirm db_storage is readable",
  "4) Keep WeChat running in the current X11 or Xwayland session",
  `Docs: ${formatDocsLink("/channels/wechat-linux", "channels/wechat-linux")}`,
];

const ALLOW_FROM_HELP_LINES = [
  "Allowlist WeChat DMs by sender id.",
  "Examples:",
  "- wxid_example123",
  "- wechat-linux:wxid_example123",
  "Multiple entries: comma-separated.",
  `Docs: ${formatDocsLink("/channels/wechat-linux", "channels/wechat-linux")}`,
];

const GROUP_ALLOW_FROM_HELP_LINES = [
  "Allow group senders by stable WeChat sender id.",
  "Examples:",
  "- wxid_example123",
  "- *",
  "Multiple entries: comma-separated.",
  `Docs: ${formatDocsLink("/channels/wechat-linux", "channels/wechat-linux")}`,
];

function parseWechatAllowFromEntries(raw: string): { entries: string[]; error?: string } {
  return parseSetupEntriesAllowingWildcard(raw, (entry) => {
    const normalized = normalizeWechatLinuxAllowEntry(entry);
    if (!normalized) {
      return { error: `Invalid entry: ${entry}` };
    }
    return { value: normalized };
  });
}

function updateWechatLinuxConfig(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Record<string, unknown>,
): OpenClawConfig {
  return patchWechatLinuxAccountConfig({
    cfg,
    accountId,
    enabled: true,
    patch,
  });
}

function validateWindowMode(value: string): string | undefined {
  return ["auto", "standalone", "main"].includes(value)
    ? undefined
    : "Window mode must be auto, standalone, or main.";
}

function readCurrentValue(
  cfg: OpenClawConfig,
  accountId: string,
  key: keyof ReturnType<typeof resolveWechatLinuxAccount>["config"],
): string | undefined {
  const account = resolveWechatLinuxAccount({ cfg: cfg as CoreConfig, accountId });
  const value = account.config[key];
  return typeof value === "string" ? value || undefined : undefined;
}

async function promptWechatLinuxAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  return await promptParsedAllowFromForAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    defaultAccountId: DEFAULT_ACCOUNT_ID,
    prompter: params.prompter,
    noteTitle: "WeChat allowlist",
    noteLines: ALLOW_FROM_HELP_LINES,
    message: "WeChat allowFrom (sender ids)",
    placeholder: "wxid_example123, wxid_example456",
    parseEntries: parseWechatAllowFromEntries,
    getExistingAllowFrom: ({ cfg, accountId }) =>
      resolveWechatLinuxAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom ?? [],
    applyAllowFrom: ({ cfg, accountId, allowFrom }) =>
      setWechatLinuxAllowFrom(cfg, accountId, allowFrom),
  });
}

export const wechatLinuxDmPolicy: ChannelSetupDmPolicy = {
  label: "WeChat Linux",
  channel,
  policyKey: "channels.wechat-linux.dmPolicy",
  allowFromKey: "channels.wechat-linux.allowFrom",
  resolveConfigKeys: (_cfg, accountId) => {
    const normalized = normalizeAccountId(accountId);
    if (normalized === DEFAULT_ACCOUNT_ID) {
      return {
        policyKey: "channels.wechat-linux.dmPolicy",
        allowFromKey: "channels.wechat-linux.allowFrom",
      };
    }
    return {
      policyKey: `channels.wechat-linux.accounts.${normalized}.dmPolicy`,
      allowFromKey: `channels.wechat-linux.accounts.${normalized}.allowFrom`,
    };
  },
  getCurrent: (cfg, accountId) =>
    resolveWechatLinuxAccount({ cfg: cfg as CoreConfig, accountId }).config.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy, accountId) =>
    updateWechatLinuxConfig(cfg, normalizeAccountId(accountId), { dmPolicy: policy }),
  promptAllowFrom: promptWechatLinuxAllowFrom,
};

const PYWXDUMP_ROOT_INPUT_KEY = "pyWxDumpRoot" as keyof ChannelSetupInput;
const PYTHON_PATH_INPUT_KEY = "pythonPath" as keyof ChannelSetupInput;
const KEY_FILE_INPUT_KEY = "keyFile" as keyof ChannelSetupInput;
const DB_DIR_INPUT_KEY = "dbDir" as keyof ChannelSetupInput;
const OUTPUT_DIR_INPUT_KEY = "outputDir" as keyof ChannelSetupInput;
const DISPLAY_INPUT_KEY = "display" as keyof ChannelSetupInput;
const XAUTHORITY_INPUT_KEY = "xauthority" as keyof ChannelSetupInput;
const WINDOW_CLASS_INPUT_KEY = "windowClass" as keyof ChannelSetupInput;
const WINDOW_MODE_INPUT_KEY = "windowMode" as keyof ChannelSetupInput;

export const wechatLinuxSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs PyWxDump root",
    configuredHint: "PyWxDump bridge ready",
    unconfiguredHint: "set PyWxDump root",
    configuredScore: 1,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) =>
      listWechatLinuxAccountIds(cfg as CoreConfig).some(
        (accountId) => resolveWechatLinuxAccount({ cfg: cfg as CoreConfig, accountId }).configured,
      ),
    resolveStatusLines: ({ cfg, configured }) => [
      `WeChat Linux: ${configured ? "configured" : "needs PyWxDump root"}`,
      `Accounts: ${listWechatLinuxAccountIds(cfg as CoreConfig).length || 0}`,
    ],
  },
  introNote: {
    title: "WeChat Linux setup",
    lines: SETUP_HELP_LINES,
  },
  credentials: [],
  textInputs: [
    {
      inputKey: PYWXDUMP_ROOT_INPUT_KEY,
      message: "PyWxDump repo root",
      placeholder: "/home/user/github/PyWxDump",
      currentValue: ({ cfg, accountId }) => readCurrentValue(cfg, accountId, "pyWxDumpRoot"),
      keepPrompt: (value) => `PyWxDump root set (${value}). Keep it?`,
      validate: ({ value }) =>
        String(value ?? "").trim() ? undefined : "PyWxDump repo root is required.",
      normalizeValue: ({ value }) => String(value).trim(),
      applySet: async ({ cfg, accountId, value }) =>
        updateWechatLinuxConfig(cfg, accountId, { pyWxDumpRoot: value.trim() }),
    },
    {
      inputKey: PYTHON_PATH_INPUT_KEY,
      message: "Python executable",
      placeholder: "python3",
      required: false,
      currentValue: ({ cfg, accountId }) => readCurrentValue(cfg, accountId, "pythonPath"),
      initialValue: () => "python3",
      applySet: async ({ cfg, accountId, value }) =>
        updateWechatLinuxConfig(cfg, accountId, { pythonPath: value.trim() }),
    },
    {
      inputKey: KEY_FILE_INPUT_KEY,
      message: "WeChat key file",
      placeholder: "~/.wx_db_keys.json",
      required: false,
      currentValue: ({ cfg, accountId }) => readCurrentValue(cfg, accountId, "keyFile"),
      initialValue: () => "~/.wx_db_keys.json",
      applySet: async ({ cfg, accountId, value }) =>
        updateWechatLinuxConfig(cfg, accountId, { keyFile: value.trim() }),
    },
    {
      inputKey: DB_DIR_INPUT_KEY,
      message: "db_storage dir (optional)",
      placeholder: "~/Documents/xwechat_files/.../db_storage",
      required: false,
      applyEmptyValue: true,
      currentValue: ({ cfg, accountId }) => readCurrentValue(cfg, accountId, "dbDir"),
      applySet: async ({ cfg, accountId, value }) =>
        updateWechatLinuxConfig(cfg, accountId, { dbDir: value.trim() || undefined }),
    },
    {
      inputKey: OUTPUT_DIR_INPUT_KEY,
      message: "Bridge output dir",
      placeholder: "~/wx_decrypted",
      required: false,
      currentValue: ({ cfg, accountId }) => readCurrentValue(cfg, accountId, "outputDir"),
      initialValue: () => "~/wx_decrypted",
      applySet: async ({ cfg, accountId, value }) =>
        updateWechatLinuxConfig(cfg, accountId, { outputDir: value.trim() }),
    },
    {
      inputKey: DISPLAY_INPUT_KEY,
      message: "DISPLAY (optional)",
      placeholder: ":0",
      required: false,
      applyEmptyValue: true,
      currentValue: ({ cfg, accountId }) => readCurrentValue(cfg, accountId, "display"),
      applySet: async ({ cfg, accountId, value }) =>
        updateWechatLinuxConfig(cfg, accountId, { display: value.trim() || undefined }),
    },
    {
      inputKey: XAUTHORITY_INPUT_KEY,
      message: "XAUTHORITY (optional)",
      placeholder: "~/.Xauthority",
      required: false,
      applyEmptyValue: true,
      currentValue: ({ cfg, accountId }) => readCurrentValue(cfg, accountId, "xauthority"),
      applySet: async ({ cfg, accountId, value }) =>
        updateWechatLinuxConfig(cfg, accountId, { xauthority: value.trim() || undefined }),
    },
    {
      inputKey: WINDOW_CLASS_INPUT_KEY,
      message: "WeChat window class",
      placeholder: "wechat",
      required: false,
      currentValue: ({ cfg, accountId }) => readCurrentValue(cfg, accountId, "windowClass"),
      initialValue: () => "wechat",
      applySet: async ({ cfg, accountId, value }) =>
        updateWechatLinuxConfig(cfg, accountId, { windowClass: value.trim() }),
    },
    {
      inputKey: WINDOW_MODE_INPUT_KEY,
      message: "Window mode",
      placeholder: "auto",
      required: false,
      currentValue: ({ cfg, accountId }) => readCurrentValue(cfg, accountId, "windowMode"),
      initialValue: () => "auto",
      validate: ({ value }) => validateWindowMode(String(value).trim()),
      normalizeValue: ({ value }) => String(value).trim().toLowerCase(),
      applySet: async ({ cfg, accountId, value }) =>
        updateWechatLinuxConfig(cfg, accountId, { windowMode: value.trim().toLowerCase() }),
    },
  ],
  dmPolicy: wechatLinuxDmPolicy,
  allowFrom: createAllowFromSection({
    helpTitle: "WeChat allowlist",
    helpLines: ALLOW_FROM_HELP_LINES,
    message: "WeChat allowFrom (sender ids)",
    placeholder: "wxid_example123, wxid_example456",
    invalidWithoutCredentialNote: "Use a stable WeChat sender id like wxid_*.",
    parseId: (raw) => {
      const normalized = normalizeWechatLinuxAllowEntry(raw);
      return normalized || null;
    },
    apply: async ({ cfg, accountId, allowFrom }) =>
      setWechatLinuxAllowFrom(cfg, accountId ?? DEFAULT_ACCOUNT_ID, allowFrom),
  }),
  groupAccess: {
    label: "WeChat group senders",
    helpTitle: "WeChat group sender allowlist",
    helpLines: GROUP_ALLOW_FROM_HELP_LINES,
    placeholder: "wxid_example123, *",
    currentPolicy: ({ cfg, accountId }) =>
      resolveWechatLinuxAccount({ cfg: cfg as CoreConfig, accountId }).config.groupPolicy ??
      "allowlist",
    currentEntries: ({ cfg, accountId }) =>
      resolveWechatLinuxAccount({ cfg: cfg as CoreConfig, accountId }).config.groupAllowFrom ?? [],
    updatePrompt: ({ cfg, accountId }) =>
      Boolean(
        resolveWechatLinuxAccount({ cfg: cfg as CoreConfig, accountId }).config.groupAllowFrom,
      ),
    setPolicy: ({ cfg, accountId, policy }) =>
      setWechatLinuxGroupAccess({
        cfg,
        accountId,
        groupPolicy: policy as GroupPolicy,
      }),
    resolveAllowlist: async ({ entries }) => parseWechatAllowFromEntries(entries.join(",")).entries,
    applyAllowlist: ({ cfg, accountId, resolved }) =>
      setWechatLinuxGroupAccess({
        cfg,
        accountId,
        groupPolicy: "allowlist",
        groupAllowFrom: resolved as string[],
      }),
  },
  completionNote: {
    title: "WeChat Linux next steps",
    lines: [
      "Run `openclaw channels status --probe` to verify bridge prerequisites.",
      "Keep WeChat logged in and visible to the current X11 session before starting the gateway.",
      `Docs: ${formatDocsLink("/channels/wechat-linux", "channels/wechat-linux")}`,
    ],
  },
};
