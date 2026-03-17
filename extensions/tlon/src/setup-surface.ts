import {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  type ChannelSetupWizard,
} from "openclaw/plugin-sdk/setup";
import { applyTlonSetupConfig, type TlonSetupInput, tlonSetupAdapter } from "./setup-core.js";
import { normalizeShip } from "./targets.js";
import { listTlonAccountIds, resolveTlonAccount, type TlonResolvedAccount } from "./types.js";
import { isBlockedUrbitHostname, validateUrbitBaseUrl } from "./urbit/base-url.js";

const channel = "tlon" as const;

function isConfigured(account: TlonResolvedAccount): boolean {
  return Boolean(account.ship && account.url && account.code);
}

function parseList(value: string): string[] {
  return value
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export { tlonSetupAdapter } from "./setup-core.js";

export const tlonSetupWizard: ChannelSetupWizard = {
  channel,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs setup",
    configuredHint: "configured",
    unconfiguredHint: "urbit messenger",
    configuredScore: 1,
    unconfiguredScore: 4,
    resolveConfigured: ({ cfg }) => {
      const accountIds = listTlonAccountIds(cfg);
      return accountIds.length > 0
        ? accountIds.some((accountId) => isConfigured(resolveTlonAccount(cfg, accountId)))
        : isConfigured(resolveTlonAccount(cfg, DEFAULT_ACCOUNT_ID));
    },
    resolveStatusLines: ({ cfg }) => {
      const accountIds = listTlonAccountIds(cfg);
      const configured =
        accountIds.length > 0
          ? accountIds.some((accountId) => isConfigured(resolveTlonAccount(cfg, accountId)))
          : isConfigured(resolveTlonAccount(cfg, DEFAULT_ACCOUNT_ID));
      return [`Tlon: ${configured ? "configured" : "needs setup"}`];
    },
  },
  introNote: {
    title: "Tlon setup",
    lines: [
      "You need your Urbit ship URL and login code.",
      "Example URL: https://your-ship-host",
      "Example ship: ~sampel-palnet",
      "If your ship URL is on a private network (LAN/localhost), you must explicitly allow it during setup.",
      `Docs: ${formatDocsLink("/channels/tlon", "channels/tlon")}`,
    ],
  },
  credentials: [],
  textInputs: [
    {
      inputKey: "ship",
      message: "Ship name",
      placeholder: "~sampel-palnet",
      currentValue: ({ cfg, accountId }) => resolveTlonAccount(cfg, accountId).ship ?? undefined,
      validate: ({ value }) => (String(value ?? "").trim() ? undefined : "Required"),
      normalizeValue: ({ value }) => normalizeShip(String(value).trim()),
      applySet: async ({ cfg, accountId, value }) =>
        applyTlonSetupConfig({
          cfg,
          accountId,
          input: { ship: value },
        }),
    },
    {
      inputKey: "url",
      message: "Ship URL",
      placeholder: "https://your-ship-host",
      currentValue: ({ cfg, accountId }) => resolveTlonAccount(cfg, accountId).url ?? undefined,
      validate: ({ value }) => {
        const next = validateUrbitBaseUrl(String(value ?? ""));
        if (!next.ok) {
          return next.error;
        }
        return undefined;
      },
      normalizeValue: ({ value }) => String(value).trim(),
      applySet: async ({ cfg, accountId, value }) =>
        applyTlonSetupConfig({
          cfg,
          accountId,
          input: { url: value },
        }),
    },
    {
      inputKey: "code",
      message: "Login code",
      placeholder: "lidlut-tabwed-pillex-ridrup",
      currentValue: ({ cfg, accountId }) => resolveTlonAccount(cfg, accountId).code ?? undefined,
      validate: ({ value }) => (String(value ?? "").trim() ? undefined : "Required"),
      normalizeValue: ({ value }) => String(value).trim(),
      applySet: async ({ cfg, accountId, value }) =>
        applyTlonSetupConfig({
          cfg,
          accountId,
          input: { code: value },
        }),
    },
  ],
  finalize: async ({ cfg, accountId, prompter }) => {
    let next = cfg;
    const resolved = resolveTlonAccount(next, accountId);
    const validatedUrl = validateUrbitBaseUrl(resolved.url ?? "");
    if (!validatedUrl.ok) {
      throw new Error(`Invalid URL: ${validatedUrl.error}`);
    }

    let allowPrivateNetwork = resolved.allowPrivateNetwork ?? false;
    if (isBlockedUrbitHostname(validatedUrl.hostname)) {
      allowPrivateNetwork = await prompter.confirm({
        message:
          "Ship URL looks like a private/internal host. Allow private network access? (SSRF risk)",
        initialValue: allowPrivateNetwork,
      });
      if (!allowPrivateNetwork) {
        throw new Error("Refusing private/internal Ship URL without explicit approval");
      }
    }
    next = applyTlonSetupConfig({
      cfg: next,
      accountId,
      input: { allowPrivateNetwork },
    });

    const currentGroups = resolved.groupChannels;
    const wantsGroupChannels = await prompter.confirm({
      message: "Add group channels manually? (optional)",
      initialValue: currentGroups.length > 0,
    });
    if (wantsGroupChannels) {
      const entry = await prompter.text({
        message: "Group channels (comma-separated)",
        placeholder: "chat/~host-ship/general, chat/~host-ship/support",
        initialValue: currentGroups.join(", ") || undefined,
      });
      next = applyTlonSetupConfig({
        cfg: next,
        accountId,
        input: { groupChannels: parseList(String(entry ?? "")) },
      });
    }

    const currentAllowlist = resolved.dmAllowlist;
    const wantsAllowlist = await prompter.confirm({
      message: "Restrict DMs with an allowlist?",
      initialValue: currentAllowlist.length > 0,
    });
    if (wantsAllowlist) {
      const entry = await prompter.text({
        message: "DM allowlist (comma-separated ship names)",
        placeholder: "~zod, ~nec",
        initialValue: currentAllowlist.join(", ") || undefined,
      });
      next = applyTlonSetupConfig({
        cfg: next,
        accountId,
        input: {
          dmAllowlist: parseList(String(entry ?? "")).map((ship) => normalizeShip(ship)),
        },
      });
    }

    const autoDiscoverChannels = await prompter.confirm({
      message: "Enable auto-discovery of group channels?",
      initialValue: resolved.autoDiscoverChannels ?? true,
    });
    next = applyTlonSetupConfig({
      cfg: next,
      accountId,
      input: { autoDiscoverChannels },
    });

    return { cfg: next };
  },
};
