import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  mergeAllowlist,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "openclaw/plugin-sdk/allow-from";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import { normalizeMainKey } from "openclaw/plugin-sdk/routing";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { warn, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveSlackAccountAllowFrom,
  resolveSlackAccountDmPolicy,
  mergeSlackAccountConfig,
} from "../accounts.js";
import { SLACK_TEXT_LIMIT } from "../limits.js";
import { resolveSlackChannelAllowlist } from "../resolve-channels.js";
import { resolveSlackUserAllowlist, type SlackUserResolution } from "../resolve-users.js";
import { normalizeAllowList } from "./allow-list.js";
import {
  isDangerousNameMatchingEnabled,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "./config.runtime.js";
import type { SlackMonitorContext } from "./context.js";
import { assertEnterpriseSlackPolicyConfig } from "./enterprise-install.js";
import { formatSlackChannelResolved, formatSlackUserResolved } from "./provider-support.js";
import { formatUnknownError } from "./reconnect-policy.js";
import { createSlackSystemEventRouteResolver } from "./system-event-session.js";

export function resolveSlackMonitorPolicy(
  cfg: OpenClawConfig,
  accountId: string,
  runtime?: RuntimeEnv,
) {
  const slack = mergeSlackAccountConfig(cfg, accountId);
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: cfg.channels?.slack !== undefined,
    groupPolicy: slack.groupPolicy,
    defaultGroupPolicy: resolveDefaultGroupPolicy(cfg),
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "slack",
    accountId,
    log: (message) => runtime?.log?.(warn(message)),
  });
  return {
    historyLimit: Math.max(
      0,
      slack.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
    ),
    dmHistoryLimit: Math.max(0, slack.dmHistoryLimit ?? 0),
    sessionScope: cfg.session?.scope ?? ("per-sender" as const),
    mainKey: normalizeMainKey(cfg.session?.mainKey),
    dmEnabled: slack.dm?.enabled ?? true,
    dmPolicy: resolveSlackAccountDmPolicy({ cfg, accountId }) ?? "pairing",
    allowFrom: normalizeAllowList(resolveSlackAccountAllowFrom({ cfg, accountId })),
    allowNameMatching: isDangerousNameMatchingEnabled(slack),
    groupDmEnabled: slack.dm?.groupEnabled ?? false,
    groupDmChannels: normalizeAllowList(slack.dm?.groupChannels),
    defaultRequireMention: slack.requireMention ?? true,
    channelsConfig: slack.channels,
    channelsConfigKeys: Object.keys(slack.channels ?? {}),
    groupPolicy,
    useAccessGroups: true,
    reactionMode: slack.reactionNotifications ?? ("own" as const),
    reactionAllowlist: slack.reactionAllowlist ?? [],
    replyToMode: slack.replyToMode ?? ("off" as const),
    threadHistoryScope: slack.thread?.historyScope ?? ("thread" as const),
    threadInheritParent: slack.thread?.inheritParent ?? false,
    textLimit: resolveTextChunkLimit(cfg, "slack", accountId, { fallbackLimit: SLACK_TEXT_LIMIT }),
    typingReaction: slack.typingReaction?.trim() ?? "",
  };
}

export function createSlackRuntimeContextReader(ctx: SlackMonitorContext, lookupToken: string) {
  const readConfig = createRuntimeConfigReader(ctx.cfg);
  let current:
    | {
        cfg: OpenClawConfig;
        identity: SlackMonitorContext["installationIdentity"];
        pending: Promise<SlackMonitorContext>;
      }
    | undefined;
  return () => {
    const cfg = readConfig();
    if (!current || current.cfg !== cfg || current.identity !== ctx.installationIdentity) {
      // Identity and transport caches stay monitor-owned; policy and name resolution
      // finish on an unpublished snapshot so later reloads cannot rewrite admitted work.
      // SAFETY: The prototype supplies the complete typed monitor; only policy fields are replaced.
      const next = Object.create(ctx) as SlackMonitorContext;
      Object.assign(next, { cfg }, resolveSlackMonitorPolicy(cfg, ctx.accountId, ctx.runtime));
      next.resolveSlackSystemEventRoute = createSlackSystemEventRouteResolver({
        cfg,
        accountId: ctx.accountId,
        getTeamId: () => ctx.teamId,
        mainKey: next.mainKey,
        threadInheritParent: next.threadInheritParent,
        recallSlackChannelType: ctx.recallSlackChannelType,
      });
      next.readRuntimeContext = async () => next;
      next.isRuntimePolicyCurrent = () => readConfig() === cfg;
      current = {
        cfg,
        identity: ctx.installationIdentity,
        pending: resolveWorkspacePolicy(next, lookupToken).then(() => next),
      };
    }
    return current.pending;
  };
}

function resolveStableSlackUserIdEntry(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const mention = /^<@([A-Z][A-Z0-9]+)>$/i.exec(trimmed);
  if (mention) {
    return mention[1]?.toUpperCase();
  }
  const prefixed = /^(?:slack:|user:)([A-Z][A-Z0-9]+)$/i.exec(trimmed);
  if (prefixed) {
    return prefixed[1]?.toUpperCase();
  }
  return /^[UW][A-Z0-9]+$/i.test(trimmed) ? trimmed.toUpperCase() : undefined;
}

function resolveStableSlackUserAllowlistEntries(entries: string[]): SlackUserResolution[] {
  const resolved: SlackUserResolution[] = [];
  for (const input of entries) {
    const id = resolveStableSlackUserIdEntry(input);
    if (id) {
      resolved.push({ input, resolved: true, id });
    }
  }
  return resolved;
}

async function resolveWorkspacePolicy(ctx: SlackMonitorContext, resolveToken: string) {
  if (ctx.installationIdentity.kind === "enterprise") {
    assertEnterpriseSlackPolicyConfig({
      config: mergeSlackAccountConfig(ctx.cfg, ctx.accountId),
      accountId: ctx.accountId,
    });
    return;
  }
  const runtime = ctx.runtime;
  const allowNameMatching = ctx.allowNameMatching;
  const allowFrom = ctx.allowFrom;
  let channelsConfig = ctx.channelsConfig;
  if (ctx.installationIdentity.kind !== "workspace") {
    return;
  }
  if (channelsConfig && Object.keys(channelsConfig).length > 0) {
    try {
      const entries = Object.keys(channelsConfig).filter((key) => key !== "*");
      if (entries.length > 0) {
        const resolved = await resolveSlackChannelAllowlist({ token: resolveToken, entries });
        const nextChannels = { ...channelsConfig };
        const mapping: string[] = [];
        const unresolved: string[] = [];
        for (const entry of resolved) {
          const source = channelsConfig?.[entry.input];
          if (!source) {
            continue;
          }
          if (!entry.resolved || !entry.id) {
            unresolved.push(entry.input);
            continue;
          }
          const resolvedLabel = formatSlackChannelResolved(entry);
          if (resolvedLabel) {
            mapping.push(resolvedLabel);
          }
          const existing = nextChannels[entry.id] ?? {};
          nextChannels[entry.id] = { ...source, ...existing };
        }
        channelsConfig = nextChannels;
        ctx.channelsConfig = nextChannels;
        summarizeMapping("slack channels", mapping, unresolved, runtime);
      }
    } catch (err) {
      runtime.log?.(
        `slack channel resolve failed; using config entries. ${formatUnknownError(err)}`,
      );
    }
  }

  const dmEntries = new Set(normalizeStringEntries(allowFrom).filter((entry) => entry !== "*"));
  const userEntries = new Set(dmEntries);
  for (const channel of Object.values(channelsConfig ?? {})) {
    addAllowlistUserEntriesFromConfigEntry(userEntries, channel);
  }
  const entries = [...userEntries];
  const resolved = resolveStableSlackUserAllowlistEntries(entries);
  if (allowNameMatching && entries.length > 0) {
    try {
      resolved.push(...(await resolveSlackUserAllowlist({ token: resolveToken, entries })));
    } catch (err) {
      runtime.log?.(`slack user resolve failed; using config entries. ${formatUnknownError(err)}`);
    }
  }
  const { additions } = buildAllowlistResolutionSummary(
    resolved.filter((entry) => dmEntries.has(entry.input)),
    { formatResolved: formatSlackUserResolved },
  );
  ctx.allowFrom = normalizeAllowList(mergeAllowlist({ existing: allowFrom, additions }));
  const { resolvedMap, mapping, unresolved } = buildAllowlistResolutionSummary(resolved, {
    formatResolved: formatSlackUserResolved,
  });
  if (channelsConfig) {
    ctx.channelsConfig = patchAllowlistUsersInConfigEntries({
      entries: channelsConfig,
      resolvedMap,
    });
  }
  summarizeMapping("slack users", mapping, unresolved, runtime);
  ctx.channelsConfigKeys = Object.keys(ctx.channelsConfig ?? {});
}
