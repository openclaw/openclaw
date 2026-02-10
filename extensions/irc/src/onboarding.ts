import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  promptAccountId,
  promptChannelAccessConfig,
  type ChannelOnboardingAdapter,
  type ChannelOnboardingDmPolicy,
  type DmPolicy,
  type WizardPrompter,
} from "openclaw/plugin-sdk";
import type { CoreConfig, IrcAccountConfig, IrcNickServConfig } from "./types.js";
import { listIrcAccountIds, resolveDefaultIrcAccountId, resolveIrcAccount } from "./accounts.js";
import {
  isChannelTarget,
  normalizeIrcAllowEntry,
  normalizeIrcMessagingTarget,
} from "./normalize.js";

const channel = "irc" as const;

function parseListInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePort(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function normalizeGroupEntry(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  const normalized = normalizeIrcMessagingTarget(trimmed) ?? trimmed;
  if (isChannelTarget(normalized)) {
    return normalized;
  }
  return `#${normalized.replace(/^#+/, "")}`;
}

function updateIrcAccountConfig(
  cfg: CoreConfig,
  accountId: string,
  patch: Partial<IrcAccountConfig>,
): CoreConfig {
  const current = cfg.channels?.irc ?? {};
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        irc: {
          ...current,
          ...patch,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      irc: {
        ...current,
        accounts: {
          ...current.accounts,
          [accountId]: {
            ...current.accounts?.[accountId],
            ...patch,
          },
        },
      },
    },
  };
}

function setIrcDmPolicy(cfg: CoreConfig, dmPolicy: DmPolicy): CoreConfig {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.irc?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      irc: {
        ...cfg.channels?.irc,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setIrcAllowFrom(cfg: CoreConfig, allowFrom: string[]): CoreConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      irc: {
        ...cfg.channels?.irc,
        allowFrom,
      },
    },
  };
}

function setIrcNickServ(
  cfg: CoreConfig,
  accountId: string,
  nickserv?: IrcNickServConfig,
): CoreConfig {
  return updateIrcAccountConfig(cfg, accountId, { nickserv });
}

function setIrcGroupAccess(
  cfg: CoreConfig,
  accountId: string,
  policy: "open" | "allowlist" | "disabled",
  entries: string[],
): CoreConfig {
  if (policy !== "allowlist") {
    return updateIrcAccountConfig(cfg, accountId, { enabled: true, groupPolicy: policy });
  }
  const normalizedEntries = [
    ...new Set(entries.map((entry) => normalizeGroupEntry(entry)).filter(Boolean)),
  ];
  const groups = Object.fromEntries(normalizedEntries.map((entry) => [entry, {}]));
  return updateIrcAccountConfig(cfg, accountId, {
    enabled: true,
    groupPolicy: "allowlist",
    groups,
  });
}

async function noteIrcSetupHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "IRC needs server host + bot nick.",
      "Recommended: TLS on port 6697.",
      "Optional: NickServ identify/register can be configured in onboarding.",
      'Set channels.irc.groupPolicy="allowlist" and channels.irc.groups for tighter channel control.',
      'Note: IRC channels are mention-gated by default. To allow unmentioned replies, set channels.irc.groups["#channel"].requireMention=false (or "*" for all).',
      "Env vars supported: IRC_HOST, IRC_PORT, IRC_TLS, IRC_NICK, IRC_USERNAME, IRC_REALNAME, IRC_PASSWORD, IRC_CHANNELS, IRC_NICKSERV_PASSWORD, IRC_NICKSERV_REGISTER_EMAIL.",
      `Docs: ${formatDocsLink("/channels/irc", "channels/irc")}`,
    ].join("\n"),
    "IRC setup",
  );
}

async function promptIrcAllowFrom(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<CoreConfig> {
  const existing = params.cfg.channels?.irc?.allowFrom ?? [];

  await params.prompter.note(
    [
      "Allowlist IRC DMs by sender.",
      "Examples:",
      "- alice",
      "- alice![redacted-email]",
      "Multiple entries: comma-separated.",
    ].join("\n"),
    "IRC allowlist",
  );

  const raw = await params.prompter.text({
    message: "IRC allowFrom (nick or nick!user@host)",
    placeholder: "alice, bob![redacted-email]",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
  });

  const parsed = parseListInput(String(raw));
  const normalized = [
    ...new Set(
      parsed
        .map((entry) => normalizeIrcAllowEntry(entry))
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  return setIrcAllowFrom(params.cfg, normalized);
}

async function promptIrcNickServConfig(params: {
  cfg: CoreConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<CoreConfig> {
  const resolved = resolveIrcAccount({ cfg: params.cfg, accountId: params.accountId });
  const existing = resolved.config.nickserv;
  const hasExisting = Boolean(existing?.password || existing?.passwordFile);
  const wants = await params.prompter.confirm({
    message: hasExisting ? "Update NickServ settings?" : "Configure NickServ identify/register?",
    initialValue: hasExisting,
  });
  if (!wants) {
    return params.cfg;
  }

  const service = String(
    await params.prompter.text({
      message: "NickServ service nick",
      initialValue: existing?.service || "NickServ",
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    }),
  ).trim();

  const useEnvPassword =
    params.accountId === DEFAULT_ACCOUNT_ID &&
    Boolean(process.env.IRC_NICKSERV_PASSWORD?.trim()) &&
    !(existing?.password || existing?.passwordFile)
      ? await params.prompter.confirm({
          message: "IRC_NICKSERV_PASSWORD detected. Use env var?",
          initialValue: true,
        })
      : false;

  const password = useEnvPassword
    ? undefined
    : String(
        await params.prompter.text({
          message: "NickServ password (blank to disable NickServ auth)",
          validate: () => undefined,
        }),
      ).trim();

  if (!password && !useEnvPassword) {
    return setIrcNickServ(params.cfg, params.accountId, {
      enabled: false,
      service,
    });
  }

  const register = await params.prompter.confirm({
    message: "Send NickServ REGISTER on connect?",
    initialValue: existing?.register ?? false,
  });
  const registerEmail = register
    ? String(
        await params.prompter.text({
          message: "NickServ register email",
          initialValue:
            existing?.registerEmail ||
            (params.accountId === DEFAULT_ACCOUNT_ID
              ? process.env.IRC_NICKSERV_REGISTER_EMAIL
              : undefined),
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim()
    : undefined;

  return setIrcNickServ(params.cfg, params.accountId, {
    enabled: true,
    service,
    ...(password ? { password } : {}),
    register,
    ...(registerEmail ? { registerEmail } : {}),
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "IRC",
  channel,
  policyKey: "channels.irc.dmPolicy",
  allowFromKey: "channels.irc.allowFrom",
  getCurrent: (cfg) => (cfg as CoreConfig).channels?.irc?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setIrcDmPolicy(cfg as CoreConfig, policy),
  promptAllowFrom: promptIrcAllowFrom,
};

export const ircOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const coreCfg = cfg as CoreConfig;
    const configured = listIrcAccountIds(coreCfg).some(
      (accountId) => resolveIrcAccount({ cfg: coreCfg, accountId }).configured,
    );
    return {
      channel,
      configured,
      statusLines: [`IRC: ${configured ? "configured" : "needs host + nick"}`],
      selectionHint: configured ? "configured" : "needs host + nick",
      quickstartScore: configured ? 1 : 0,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    let next = cfg as CoreConfig;
    const ircOverride = accountOverrides.irc?.trim();
    const defaultAccountId = resolveDefaultIrcAccountId(next);
    let accountId = ircOverride || defaultAccountId;
    if (shouldPromptAccountIds && !ircOverride) {
      accountId = await promptAccountId({
        cfg: next,
        prompter,
        label: "IRC",
        currentId: accountId,
        listAccountIds: listIrcAccountIds,
        defaultAccountId,
      });
    }

    const resolved = resolveIrcAccount({ cfg: next, accountId });
    const isDefaultAccount = accountId === DEFAULT_ACCOUNT_ID;
    const envHost = isDefaultAccount ? process.env.IRC_HOST?.trim() : "";
    const envNick = isDefaultAccount ? process.env.IRC_NICK?.trim() : "";
    const envReady = Boolean(envHost && envNick);

    if (!resolved.configured) {
      await noteIrcSetupHelp(prompter);
    }

    let useEnv = false;
    if (envReady && isDefaultAccount && !resolved.config.host && !resolved.config.nick) {
      useEnv = await prompter.confirm({
        message: "IRC_HOST and IRC_NICK detected. Use env vars?",
        initialValue: true,
      });
    }

    if (useEnv) {
      next = updateIrcAccountConfig(next, accountId, { enabled: true });
    } else {
      const host = String(
        await prompter.text({
          message: "IRC server host",
          initialValue: resolved.config.host || envHost || undefined,
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();

      const tls = await prompter.confirm({
        message: "Use TLS for IRC?",
        initialValue: resolved.config.tls ?? true,
      });
      const defaultPort = resolved.config.port ?? (tls ? 6697 : 6667);
      const portInput = await prompter.text({
        message: "IRC server port",
        initialValue: String(defaultPort),
        validate: (value) => {
          const parsed = Number.parseInt(String(value ?? "").trim(), 10);
          return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535
            ? undefined
            : "Use a port between 1 and 65535";
        },
      });
      const port = parsePort(String(portInput), defaultPort);

      const nick = String(
        await prompter.text({
          message: "IRC nick",
          initialValue: resolved.config.nick || envNick || undefined,
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();

      const username = String(
        await prompter.text({
          message: "IRC username",
          initialValue: resolved.config.username || nick || "openclaw",
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();

      const realname = String(
        await prompter.text({
          message: "IRC real name",
          initialValue: resolved.config.realname || "OpenClaw",
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();

      const channelsRaw = await prompter.text({
        message: "Auto-join IRC channels (optional, comma-separated)",
        placeholder: "#openclaw, #ops",
        initialValue: (resolved.config.channels ?? []).join(", "),
      });
      const channels = [
        ...new Set(
          parseListInput(String(channelsRaw))
            .map((entry) => normalizeGroupEntry(entry))
            .filter((entry): entry is string => Boolean(entry && entry !== "*"))
            .filter((entry) => isChannelTarget(entry)),
        ),
      ];

      next = updateIrcAccountConfig(next, accountId, {
        enabled: true,
        host,
        port,
        tls,
        nick,
        username,
        realname,
        channels: channels.length > 0 ? channels : undefined,
      });
    }

    const afterConfig = resolveIrcAccount({ cfg: next, accountId });
    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "IRC channels",
      currentPolicy: afterConfig.config.groupPolicy ?? "allowlist",
      currentEntries: Object.keys(afterConfig.config.groups ?? {}),
      placeholder: "#openclaw, #ops, *",
      updatePrompt: Boolean(afterConfig.config.groups),
    });
    if (accessConfig) {
      next = setIrcGroupAccess(next, accountId, accessConfig.policy, accessConfig.entries);

      // Mention gating: groups/channels are mention-gated by default. Make this explicit in onboarding.
      const wantsMentions = await prompter.confirm({
        message: "Require @mention to reply in IRC channels?",
        initialValue: true,
      });
      if (!wantsMentions) {
        const resolvedAfter = resolveIrcAccount({ cfg: next, accountId });
        const groups = resolvedAfter.config.groups ?? {};
        const patched = Object.fromEntries(
          Object.entries(groups).map(([key, value]) => [key, { ...value, requireMention: false }]),
        );
        next = updateIrcAccountConfig(next, accountId, { groups: patched });
      }
    }

    if (forceAllowFrom) {
      next = await promptIrcAllowFrom({ cfg: next, prompter, accountId });
    }
    next = await promptIrcNickServConfig({
      cfg: next,
      prompter,
      accountId,
    });

    await prompter.note(
      [
        "Next: restart gateway and verify status.",
        "Command: openclaw channels status --probe",
        `Docs: ${formatDocsLink("/channels/irc", "channels/irc")}`,
      ].join("\n"),
      "IRC next steps",
    );

    return { cfg: next, accountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...(cfg as CoreConfig),
    channels: {
      ...(cfg as CoreConfig).channels,
      irc: {
        ...(cfg as CoreConfig).channels?.irc,
        enabled: false,
      },
    },
  }),
};
