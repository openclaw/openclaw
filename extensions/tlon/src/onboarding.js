import {
  formatDocsLink,
  patchScopedAccountConfig,
  resolveAccountIdForConfigure,
  DEFAULT_ACCOUNT_ID
} from "openclaw/plugin-sdk/tlon";
import { buildTlonAccountFields } from "./account-fields.js";
import { listTlonAccountIds, resolveTlonAccount } from "./types.js";
import { isBlockedUrbitHostname, validateUrbitBaseUrl } from "./urbit/base-url.js";
const channel = "tlon";
function isConfigured(account) {
  return Boolean(account.ship && account.url && account.code);
}
function applyAccountConfig(params) {
  const { cfg, accountId, input } = params;
  const nextValues = {
    enabled: true,
    ...input.name ? { name: input.name } : {},
    ...buildTlonAccountFields(input)
  };
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return patchScopedAccountConfig({
      cfg,
      channelKey: channel,
      accountId,
      patch: nextValues,
      ensureChannelEnabled: false,
      ensureAccountEnabled: false
    });
  }
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch: { enabled: cfg.channels?.tlon?.enabled ?? true },
    accountPatch: nextValues,
    ensureChannelEnabled: false,
    ensureAccountEnabled: false
  });
}
async function noteTlonHelp(prompter) {
  await prompter.note(
    [
      "You need your Urbit ship URL and login code.",
      "Example URL: https://your-ship-host",
      "Example ship: ~sampel-palnet",
      "If your ship URL is on a private network (LAN/localhost), you must explicitly allow it during setup.",
      `Docs: ${formatDocsLink("/channels/tlon", "channels/tlon")}`
    ].join("\n"),
    "Tlon setup"
  );
}
function parseList(value) {
  return value.split(/[\n,;]+/g).map((entry) => entry.trim()).filter(Boolean);
}
const tlonOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const accountIds = listTlonAccountIds(cfg);
    const configured = accountIds.length > 0 ? accountIds.some((accountId) => isConfigured(resolveTlonAccount(cfg, accountId))) : isConfigured(resolveTlonAccount(cfg, DEFAULT_ACCOUNT_ID));
    return {
      channel,
      configured,
      statusLines: [`Tlon: ${configured ? "configured" : "needs setup"}`],
      selectionHint: configured ? "configured" : "urbit messenger",
      quickstartScore: configured ? 1 : 4
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const defaultAccountId = DEFAULT_ACCOUNT_ID;
    const accountId = await resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "Tlon",
      accountOverride: accountOverrides[channel],
      shouldPromptAccountIds,
      listAccountIds: listTlonAccountIds,
      defaultAccountId
    });
    const resolved = resolveTlonAccount(cfg, accountId);
    await noteTlonHelp(prompter);
    const ship = await prompter.text({
      message: "Ship name",
      placeholder: "~sampel-palnet",
      initialValue: resolved.ship ?? void 0,
      validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
    });
    const url = await prompter.text({
      message: "Ship URL",
      placeholder: "https://your-ship-host",
      initialValue: resolved.url ?? void 0,
      validate: (value) => {
        const next2 = validateUrbitBaseUrl(String(value ?? ""));
        if (!next2.ok) {
          return next2.error;
        }
        return void 0;
      }
    });
    const validatedUrl = validateUrbitBaseUrl(String(url).trim());
    if (!validatedUrl.ok) {
      throw new Error(`Invalid URL: ${validatedUrl.error}`);
    }
    let allowPrivateNetwork = resolved.allowPrivateNetwork ?? false;
    if (isBlockedUrbitHostname(validatedUrl.hostname)) {
      allowPrivateNetwork = await prompter.confirm({
        message: "Ship URL looks like a private/internal host. Allow private network access? (SSRF risk)",
        initialValue: allowPrivateNetwork
      });
      if (!allowPrivateNetwork) {
        throw new Error("Refusing private/internal Ship URL without explicit approval");
      }
    }
    const code = await prompter.text({
      message: "Login code",
      placeholder: "lidlut-tabwed-pillex-ridrup",
      initialValue: resolved.code ?? void 0,
      validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
    });
    const wantsGroupChannels = await prompter.confirm({
      message: "Add group channels manually? (optional)",
      initialValue: false
    });
    let groupChannels;
    if (wantsGroupChannels) {
      const entry = await prompter.text({
        message: "Group channels (comma-separated)",
        placeholder: "chat/~host-ship/general, chat/~host-ship/support"
      });
      const parsed = parseList(String(entry ?? ""));
      groupChannels = parsed.length > 0 ? parsed : void 0;
    }
    const wantsAllowlist = await prompter.confirm({
      message: "Restrict DMs with an allowlist?",
      initialValue: false
    });
    let dmAllowlist;
    if (wantsAllowlist) {
      const entry = await prompter.text({
        message: "DM allowlist (comma-separated ship names)",
        placeholder: "~zod, ~nec"
      });
      const parsed = parseList(String(entry ?? ""));
      dmAllowlist = parsed.length > 0 ? parsed : void 0;
    }
    const autoDiscoverChannels = await prompter.confirm({
      message: "Enable auto-discovery of group channels?",
      initialValue: resolved.autoDiscoverChannels ?? true
    });
    const next = applyAccountConfig({
      cfg,
      accountId,
      input: {
        ship: String(ship).trim(),
        url: String(url).trim(),
        code: String(code).trim(),
        allowPrivateNetwork,
        groupChannels,
        dmAllowlist,
        autoDiscoverChannels
      }
    });
    return { cfg: next, accountId };
  }
};
export {
  tlonOnboardingAdapter
};
