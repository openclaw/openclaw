import {
  formatDocsLink,
  hasConfiguredSecretInput,
  mapAllowFromEntries,
  mergeAllowFromEntries,
  patchScopedAccountConfig,
  runSingleChannelSecretStep,
  resolveAccountIdForConfigure,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  setTopLevelChannelDmPolicyWithAllowFrom
} from "openclaw/plugin-sdk/nextcloud-talk";
import {
  listNextcloudTalkAccountIds,
  resolveDefaultNextcloudTalkAccountId,
  resolveNextcloudTalkAccount
} from "./accounts.js";
const channel = "nextcloud-talk";
function setNextcloudTalkDmPolicy(cfg, dmPolicy2) {
  return setTopLevelChannelDmPolicyWithAllowFrom({
    cfg,
    channel: "nextcloud-talk",
    dmPolicy: dmPolicy2,
    getAllowFrom: (inputCfg) => mapAllowFromEntries(inputCfg.channels?.["nextcloud-talk"]?.allowFrom)
  });
}
function setNextcloudTalkAccountConfig(cfg, accountId, updates) {
  return patchScopedAccountConfig({
    cfg,
    channelKey: channel,
    accountId,
    patch: updates
  });
}
async function noteNextcloudTalkSecretHelp(prompter) {
  await prompter.note(
    [
      "1) SSH into your Nextcloud server",
      '2) Run: ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction',
      "3) Copy the shared secret you used in the command",
      "4) Enable the bot in your Nextcloud Talk room settings",
      "Tip: you can also set NEXTCLOUD_TALK_BOT_SECRET in your env.",
      `Docs: ${formatDocsLink("/channels/nextcloud-talk", "channels/nextcloud-talk")}`
    ].join("\n"),
    "Nextcloud Talk bot setup"
  );
}
async function noteNextcloudTalkUserIdHelp(prompter) {
  await prompter.note(
    [
      "1) Check the Nextcloud admin panel for user IDs",
      "2) Or look at the webhook payload logs when someone messages",
      "3) User IDs are typically lowercase usernames in Nextcloud",
      `Docs: ${formatDocsLink("/channels/nextcloud-talk", "channels/nextcloud-talk")}`
    ].join("\n"),
    "Nextcloud Talk user id"
  );
}
async function promptNextcloudTalkAllowFrom(params) {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveNextcloudTalkAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  await noteNextcloudTalkUserIdHelp(prompter);
  const parseInput = (value) => value.split(/[\n,;]+/g).map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  let resolvedIds = [];
  while (resolvedIds.length === 0) {
    const entry = await prompter.text({
      message: "Nextcloud Talk allowFrom (user id)",
      placeholder: "username",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : void 0,
      validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
    });
    resolvedIds = parseInput(String(entry));
    if (resolvedIds.length === 0) {
      await prompter.note("Please enter at least one valid user ID.", "Nextcloud Talk allowlist");
    }
  }
  const merged = [
    ...existingAllowFrom.map((item) => String(item).trim().toLowerCase()).filter(Boolean),
    ...resolvedIds
  ];
  const unique = mergeAllowFromEntries(void 0, merged);
  return setNextcloudTalkAccountConfig(cfg, accountId, {
    dmPolicy: "allowlist",
    allowFrom: unique
  });
}
async function promptNextcloudTalkAllowFromForAccount(params) {
  const accountId = params.accountId && normalizeAccountId(params.accountId) ? normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID : resolveDefaultNextcloudTalkAccountId(params.cfg);
  return promptNextcloudTalkAllowFrom({
    cfg: params.cfg,
    prompter: params.prompter,
    accountId
  });
}
const dmPolicy = {
  label: "Nextcloud Talk",
  channel,
  policyKey: "channels.nextcloud-talk.dmPolicy",
  allowFromKey: "channels.nextcloud-talk.allowFrom",
  getCurrent: (cfg) => cfg.channels?.["nextcloud-talk"]?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setNextcloudTalkDmPolicy(cfg, policy),
  promptAllowFrom: promptNextcloudTalkAllowFromForAccount
};
const nextcloudTalkOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listNextcloudTalkAccountIds(cfg).some((accountId) => {
      const account = resolveNextcloudTalkAccount({ cfg, accountId });
      return Boolean(account.secret && account.baseUrl);
    });
    return {
      channel,
      configured,
      statusLines: [`Nextcloud Talk: ${configured ? "configured" : "needs setup"}`],
      selectionHint: configured ? "configured" : "self-hosted chat",
      quickstartScore: configured ? 1 : 5
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom
  }) => {
    const defaultAccountId = resolveDefaultNextcloudTalkAccountId(cfg);
    const accountId = await resolveAccountIdForConfigure({
      cfg,
      prompter,
      label: "Nextcloud Talk",
      accountOverride: accountOverrides["nextcloud-talk"],
      shouldPromptAccountIds,
      listAccountIds: listNextcloudTalkAccountIds,
      defaultAccountId
    });
    let next = cfg;
    const resolvedAccount = resolveNextcloudTalkAccount({
      cfg: next,
      accountId
    });
    const accountConfigured = Boolean(resolvedAccount.secret && resolvedAccount.baseUrl);
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const hasConfigSecret = Boolean(
      hasConfiguredSecretInput(resolvedAccount.config.botSecret) || resolvedAccount.config.botSecretFile
    );
    let baseUrl = resolvedAccount.baseUrl;
    if (!baseUrl) {
      baseUrl = String(
        await prompter.text({
          message: "Enter Nextcloud instance URL (e.g., https://cloud.example.com)",
          validate: (value) => {
            const v = String(value ?? "").trim();
            if (!v) {
              return "Required";
            }
            if (!v.startsWith("http://") && !v.startsWith("https://")) {
              return "URL must start with http:// or https://";
            }
            return void 0;
          }
        })
      ).trim();
    }
    const secretStep = await runSingleChannelSecretStep({
      cfg: next,
      prompter,
      providerHint: "nextcloud-talk",
      credentialLabel: "bot secret",
      accountConfigured,
      hasConfigToken: hasConfigSecret,
      allowEnv,
      envValue: process.env.NEXTCLOUD_TALK_BOT_SECRET,
      envPrompt: "NEXTCLOUD_TALK_BOT_SECRET detected. Use env var?",
      keepPrompt: "Nextcloud Talk bot secret already configured. Keep it?",
      inputPrompt: "Enter Nextcloud Talk bot secret",
      preferredEnvVar: "NEXTCLOUD_TALK_BOT_SECRET",
      onMissingConfigured: async () => await noteNextcloudTalkSecretHelp(prompter),
      applyUseEnv: async (cfg2) => setNextcloudTalkAccountConfig(cfg2, accountId, {
        baseUrl
      }),
      applySet: async (cfg2, value) => setNextcloudTalkAccountConfig(cfg2, accountId, {
        baseUrl,
        botSecret: value
      })
    });
    next = secretStep.cfg;
    if (secretStep.action === "keep" && baseUrl !== resolvedAccount.baseUrl) {
      next = setNextcloudTalkAccountConfig(next, accountId, {
        baseUrl
      });
    }
    const existingApiUser = resolvedAccount.config.apiUser?.trim();
    const existingApiPasswordConfigured = Boolean(
      hasConfiguredSecretInput(resolvedAccount.config.apiPassword) || resolvedAccount.config.apiPasswordFile
    );
    const configureApiCredentials = await prompter.confirm({
      message: "Configure optional Nextcloud Talk API credentials for room lookups?",
      initialValue: Boolean(existingApiUser && existingApiPasswordConfigured)
    });
    if (configureApiCredentials) {
      const apiUser = String(
        await prompter.text({
          message: "Nextcloud Talk API user",
          initialValue: existingApiUser,
          validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
        })
      ).trim();
      const apiPasswordStep = await runSingleChannelSecretStep({
        cfg: next,
        prompter,
        providerHint: "nextcloud-talk-api",
        credentialLabel: "API password",
        accountConfigured: Boolean(existingApiUser && existingApiPasswordConfigured),
        hasConfigToken: existingApiPasswordConfigured,
        allowEnv: false,
        envPrompt: "",
        keepPrompt: "Nextcloud Talk API password already configured. Keep it?",
        inputPrompt: "Enter Nextcloud Talk API password",
        preferredEnvVar: "NEXTCLOUD_TALK_API_PASSWORD",
        applySet: async (cfg2, value) => setNextcloudTalkAccountConfig(cfg2, accountId, {
          apiUser,
          apiPassword: value
        })
      });
      next = apiPasswordStep.action === "keep" ? setNextcloudTalkAccountConfig(next, accountId, { apiUser }) : apiPasswordStep.cfg;
    }
    if (forceAllowFrom) {
      next = await promptNextcloudTalkAllowFrom({
        cfg: next,
        prompter,
        accountId
      });
    }
    return { cfg: next, accountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      "nextcloud-talk": { ...cfg.channels?.["nextcloud-talk"], enabled: false }
    }
  })
};
export {
  nextcloudTalkOnboardingAdapter
};
