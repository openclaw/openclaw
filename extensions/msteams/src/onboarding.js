import {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  mergeAllowFromEntries,
  promptChannelAccessConfig,
  setTopLevelChannelAllowFrom,
  setTopLevelChannelDmPolicyWithAllowFrom,
  setTopLevelChannelGroupPolicy,
  splitOnboardingEntries
} from "openclaw/plugin-sdk/msteams";
import {
  parseMSTeamsTeamEntry,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist
} from "./resolve-allowlist.js";
import { normalizeSecretInputString } from "./secret-input.js";
import { hasConfiguredMSTeamsCredentials, resolveMSTeamsCredentials } from "./token.js";
const channel = "msteams";
function setMSTeamsDmPolicy(cfg, dmPolicy2) {
  return setTopLevelChannelDmPolicyWithAllowFrom({
    cfg,
    channel: "msteams",
    dmPolicy: dmPolicy2
  });
}
function setMSTeamsAllowFrom(cfg, allowFrom) {
  return setTopLevelChannelAllowFrom({
    cfg,
    channel: "msteams",
    allowFrom
  });
}
function looksLikeGuid(value) {
  return /^[0-9a-fA-F-]{16,}$/.test(value);
}
async function promptMSTeamsCredentials(prompter) {
  const appId = String(
    await prompter.text({
      message: "Enter MS Teams App ID",
      validate: (value) => value?.trim() ? void 0 : "Required"
    })
  ).trim();
  const appPassword = String(
    await prompter.text({
      message: "Enter MS Teams App Password",
      validate: (value) => value?.trim() ? void 0 : "Required"
    })
  ).trim();
  const tenantId = String(
    await prompter.text({
      message: "Enter MS Teams Tenant ID",
      validate: (value) => value?.trim() ? void 0 : "Required"
    })
  ).trim();
  return { appId, appPassword, tenantId };
}
async function promptMSTeamsAllowFrom(params) {
  const existing = params.cfg.channels?.msteams?.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist MS Teams DMs by display name, UPN/email, or user id.",
      "We resolve names to user IDs via Microsoft Graph when credentials allow.",
      "Examples:",
      "- alex@example.com",
      "- Alex Johnson",
      "- 00000000-0000-0000-0000-000000000000"
    ].join("\n"),
    "MS Teams allowlist"
  );
  while (true) {
    const entry = await params.prompter.text({
      message: "MS Teams allowFrom (usernames or ids)",
      placeholder: "alex@example.com, Alex Johnson",
      initialValue: existing[0] ? String(existing[0]) : void 0,
      validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
    });
    const parts = splitOnboardingEntries(String(entry));
    if (parts.length === 0) {
      await params.prompter.note("Enter at least one user.", "MS Teams allowlist");
      continue;
    }
    const resolved = await resolveMSTeamsUserAllowlist({
      cfg: params.cfg,
      entries: parts
    }).catch(() => null);
    if (!resolved) {
      const ids2 = parts.filter((part) => looksLikeGuid(part));
      if (ids2.length !== parts.length) {
        await params.prompter.note(
          "Graph lookup unavailable. Use user IDs only.",
          "MS Teams allowlist"
        );
        continue;
      }
      const unique2 = mergeAllowFromEntries(existing, ids2);
      return setMSTeamsAllowFrom(params.cfg, unique2);
    }
    const unresolved = resolved.filter((item) => !item.resolved || !item.id);
    if (unresolved.length > 0) {
      await params.prompter.note(
        `Could not resolve: ${unresolved.map((item) => item.input).join(", ")}`,
        "MS Teams allowlist"
      );
      continue;
    }
    const ids = resolved.map((item) => item.id);
    const unique = mergeAllowFromEntries(existing, ids);
    return setMSTeamsAllowFrom(params.cfg, unique);
  }
}
async function noteMSTeamsCredentialHelp(prompter) {
  await prompter.note(
    [
      "1) Azure Bot registration \u2192 get App ID + Tenant ID",
      "2) Add a client secret (App Password)",
      "3) Set webhook URL + messaging endpoint",
      "Tip: you can also set MSTEAMS_APP_ID / MSTEAMS_APP_PASSWORD / MSTEAMS_TENANT_ID.",
      `Docs: ${formatDocsLink("/channels/msteams", "msteams")}`
    ].join("\n"),
    "MS Teams credentials"
  );
}
function setMSTeamsGroupPolicy(cfg, groupPolicy) {
  return setTopLevelChannelGroupPolicy({
    cfg,
    channel: "msteams",
    groupPolicy,
    enabled: true
  });
}
function setMSTeamsTeamsAllowlist(cfg, entries) {
  const baseTeams = cfg.channels?.msteams?.teams ?? {};
  const teams = { ...baseTeams };
  for (const entry of entries) {
    const teamKey = entry.teamKey;
    if (!teamKey) {
      continue;
    }
    const existing = teams[teamKey] ?? {};
    if (entry.channelKey) {
      const channels = { ...existing.channels };
      channels[entry.channelKey] = channels[entry.channelKey] ?? {};
      teams[teamKey] = { ...existing, channels };
    } else {
      teams[teamKey] = existing;
    }
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...cfg.channels?.msteams,
        enabled: true,
        teams
      }
    }
  };
}
const dmPolicy = {
  label: "MS Teams",
  channel,
  policyKey: "channels.msteams.dmPolicy",
  allowFromKey: "channels.msteams.allowFrom",
  getCurrent: (cfg) => cfg.channels?.msteams?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setMSTeamsDmPolicy(cfg, policy),
  promptAllowFrom: promptMSTeamsAllowFrom
};
const msteamsOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams)) || hasConfiguredMSTeamsCredentials(cfg.channels?.msteams);
    return {
      channel,
      configured,
      statusLines: [`MS Teams: ${configured ? "configured" : "needs app credentials"}`],
      selectionHint: configured ? "configured" : "needs app creds",
      quickstartScore: configured ? 2 : 0
    };
  },
  configure: async ({ cfg, prompter }) => {
    const resolved = resolveMSTeamsCredentials(cfg.channels?.msteams);
    const hasConfigCreds = hasConfiguredMSTeamsCredentials(cfg.channels?.msteams);
    const canUseEnv = Boolean(
      !hasConfigCreds && normalizeSecretInputString(process.env.MSTEAMS_APP_ID) && normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD) && normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID)
    );
    let next = cfg;
    let appId = null;
    let appPassword = null;
    let tenantId = null;
    if (!resolved && !hasConfigCreds) {
      await noteMSTeamsCredentialHelp(prompter);
    }
    if (canUseEnv) {
      const keepEnv = await prompter.confirm({
        message: "MSTEAMS_APP_ID + MSTEAMS_APP_PASSWORD + MSTEAMS_TENANT_ID detected. Use env vars?",
        initialValue: true
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            msteams: { ...next.channels?.msteams, enabled: true }
          }
        };
      } else {
        ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
      }
    } else if (hasConfigCreds) {
      const keep = await prompter.confirm({
        message: "MS Teams credentials already configured. Keep them?",
        initialValue: true
      });
      if (!keep) {
        ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
      }
    } else {
      ({ appId, appPassword, tenantId } = await promptMSTeamsCredentials(prompter));
    }
    if (appId && appPassword && tenantId) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          msteams: {
            ...next.channels?.msteams,
            enabled: true,
            appId,
            appPassword,
            tenantId
          }
        }
      };
    }
    const currentEntries = Object.entries(next.channels?.msteams?.teams ?? {}).flatMap(
      ([teamKey, value]) => {
        const channels = value?.channels ?? {};
        const channelKeys = Object.keys(channels);
        if (channelKeys.length === 0) {
          return [teamKey];
        }
        return channelKeys.map((channelKey) => `${teamKey}/${channelKey}`);
      }
    );
    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "MS Teams channels",
      currentPolicy: next.channels?.msteams?.groupPolicy ?? "allowlist",
      currentEntries,
      placeholder: "Team Name/Channel Name, teamId/conversationId",
      updatePrompt: Boolean(next.channels?.msteams?.teams)
    });
    if (accessConfig) {
      if (accessConfig.policy !== "allowlist") {
        next = setMSTeamsGroupPolicy(next, accessConfig.policy);
      } else {
        let entries = accessConfig.entries.map((entry) => parseMSTeamsTeamEntry(entry)).filter(Boolean);
        if (accessConfig.entries.length > 0 && resolveMSTeamsCredentials(next.channels?.msteams)) {
          try {
            const resolved2 = await resolveMSTeamsChannelAllowlist({
              cfg: next,
              entries: accessConfig.entries
            });
            const resolvedChannels = resolved2.filter(
              (entry) => entry.resolved && entry.teamId && entry.channelId
            );
            const resolvedTeams = resolved2.filter(
              (entry) => entry.resolved && entry.teamId && !entry.channelId
            );
            const unresolved = resolved2.filter((entry) => !entry.resolved).map((entry) => entry.input);
            entries = [
              ...resolvedChannels.map((entry) => ({
                teamKey: entry.teamId,
                channelKey: entry.channelId
              })),
              ...resolvedTeams.map((entry) => ({
                teamKey: entry.teamId
              })),
              ...unresolved.map((entry) => parseMSTeamsTeamEntry(entry)).filter(Boolean)
            ];
            if (resolvedChannels.length > 0 || resolvedTeams.length > 0 || unresolved.length > 0) {
              const summary = [];
              if (resolvedChannels.length > 0) {
                summary.push(
                  `Resolved channels: ${resolvedChannels.map((entry) => entry.channelId).filter(Boolean).join(", ")}`
                );
              }
              if (resolvedTeams.length > 0) {
                summary.push(
                  `Resolved teams: ${resolvedTeams.map((entry) => entry.teamId).filter(Boolean).join(", ")}`
                );
              }
              if (unresolved.length > 0) {
                summary.push(`Unresolved (kept as typed): ${unresolved.join(", ")}`);
              }
              await prompter.note(summary.join("\n"), "MS Teams channels");
            }
          } catch (err) {
            await prompter.note(
              `Channel lookup failed; keeping entries as typed. ${String(err)}`,
              "MS Teams channels"
            );
          }
        }
        next = setMSTeamsGroupPolicy(next, "allowlist");
        next = setMSTeamsTeamsAllowlist(next, entries);
      }
    }
    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: { ...cfg.channels?.msteams, enabled: false }
    }
  })
};
export {
  msteamsOnboardingAdapter
};
