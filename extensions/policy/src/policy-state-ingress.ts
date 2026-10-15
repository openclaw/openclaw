import { hasConfiguredAccountValue } from "openclaw/plugin-sdk/account-helpers";
import {
  asNonArrayRecord,
  isRecord,
  asBoolean as readBoolean,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { ocPathSegment } from "./policy-state-helpers.js";
import { IMPLICIT_DEFAULT_ACCOUNT_FIELDS } from "./policy-state-tool-posture.js";
import { RESERVED_CHANNEL_CONFIG_KEYS } from "./policy-state-types.js";
import type { PolicyIngressEvidence } from "./policy-state-types.js";

const ALLOWLIST_DEFAULT_INGRESS_GROUP_POLICY_CHANNELS = new Set([
  "googlechat",
  "irc",
  "line",
  "mattermost",
  "matrix",
  "msteams",
  "nextcloud-talk",
  "signal",
]);

const OPEN_GROUPS_DEFAULT_TO_NO_MENTION_CHANNELS = new Set(["feishu", "qa-channel"]);

export function scanPolicyIngress(cfg: Record<string, unknown>): readonly PolicyIngressEvidence[] {
  const channels = asNonArrayRecord(cfg.channels);
  const channelDefaults = asNonArrayRecord(channels.defaults);
  const inheritedChannelDefaults =
    channelDefaults.groupPolicy === undefined ? {} : { groupPolicy: channelDefaults.groupPolicy };
  const channelDefaultsSource = "oc://openclaw.config/channels/defaults";
  const entries: PolicyIngressEvidence[] = [];
  const session = asNonArrayRecord(cfg.session);
  const dmScope = readString(session.dmScope)?.toLowerCase();
  entries.push({
    id: "session-dm-scope",
    kind: "sessionDmScope",
    source: "oc://openclaw.config/session/dmScope",
    value: dmScope ?? "main",
    explicit: dmScope !== undefined,
  });

  for (const [channel, value] of Object.entries(channels)) {
    if (RESERVED_CHANNEL_CONFIG_KEYS.has(channel) || !isRecord(value) || value.enabled === false) {
      continue;
    }
    const channelSource = `oc://openclaw.config/channels/${ocPathSegment(channel)}`;
    const accounts = asNonArrayRecord(value.accounts);
    const configuredAccounts = Object.entries(accounts).filter(
      (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]),
    );
    const activeAccounts = configuredAccounts.filter(([, account]) => account.enabled !== false);
    if (configuredAccounts.length === 0 || hasImplicitDefaultAccountConfig(channel, value)) {
      pushChannelIngress(entries, {
        channel,
        config: value,
        inheritedConfig: inheritedChannelDefaults,
        sourceBase: channelSource,
        inheritedSourceBase: channelDefaultsSource,
        fallbackSourceBase: channelSource,
      });
    }
    for (const [accountId, account] of activeAccounts) {
      pushChannelIngress(entries, {
        channel,
        accountId,
        config: account,
        inheritedConfig: value,
        inheritNestedContainers: true,
        inheritEmptyNestedContainers: channel === "telegram" && configuredAccounts.length <= 1,
        sourceBase: `${channelSource}/accounts/${ocPathSegment(accountId)}`,
        inheritedSourceBase: channelSource,
        fallbackConfig: inheritedChannelDefaults,
        fallbackSourceBase: channelDefaultsSource,
      });
    }
  }
  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

function hasImplicitDefaultAccountConfig(
  channel: string,
  config: Record<string, unknown>,
): boolean {
  const alternatives =
    IMPLICIT_ACCOUNT_REQUIREMENTS[channel] ??
    (IMPLICIT_DEFAULT_ACCOUNT_FIELDS[channel] ?? []).map((field) => [field]);
  return alternatives.some((fields) =>
    fields.every((field) => hasConfiguredAccountValue(config[field])),
  );
}

const IMPLICIT_ACCOUNT_REQUIREMENTS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  clickclack: [["baseUrl", "workspace", "token"]],
  feishu: [["appId", "appSecret"]],
  irc: [["host", "nick"]],
  line: [["channelAccessToken"], ["tokenFile"]],
  matrix: [
    ["homeserver", "accessToken"],
    ["homeserver", "userId", "password"],
  ],
  mattermost: [["baseUrl", "botToken"]],
  "nextcloud-talk": [
    ["baseUrl", "botSecret"],
    ["baseUrl", "botSecretFile"],
  ],
};

type ChannelIngressParams = {
  readonly channel: string;
  readonly accountId?: string;
  readonly config: Record<string, unknown>;
  readonly inheritedConfig: Record<string, unknown>;
  readonly inheritNestedContainers?: boolean;
  readonly inheritEmptyNestedContainers?: boolean;
  readonly sourceBase: string;
  readonly inheritedSourceBase: string;
  readonly fallbackConfig?: Record<string, unknown>;
  readonly fallbackSourceBase: string;
};

function pushChannelIngress(entries: PolicyIngressEvidence[], params: ChannelIngressParams): void {
  const dmPolicy =
    channelDmPolicy(params.config, params.sourceBase) ??
    channelDmPolicy(params.inheritedConfig, params.inheritedSourceBase) ??
    channelDmPolicy(params.fallbackConfig ?? {}, params.fallbackSourceBase);
  entries.push({
    id: channelIngressId(params, "dm-policy"),
    kind: "channelDmPolicy",
    source: dmPolicy?.source ?? `${params.fallbackSourceBase}/dmPolicy`,
    channel: params.channel,
    ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    value: dmPolicy?.value ?? "pairing",
    explicit: dmPolicy !== undefined,
  });

  const groupPolicy = channelIngressValue(params, "groupPolicy", readString);
  const implicitGroupPolicy = channelImplicitGroupPolicy(params);
  const effectiveGroupPolicy = groupPolicy ?? implicitGroupPolicy;
  entries.push({
    id: channelIngressId(params, "group-policy"),
    kind: "channelGroupPolicy",
    source: effectiveGroupPolicy.source,
    channel: params.channel,
    ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    value: effectiveGroupPolicy.value,
    explicit: groupPolicy !== undefined,
  });

  pushChannelRequireMentionIngress(entries, params, effectiveGroupPolicy.value);
}

function channelIngressValue<T>(
  params: ChannelIngressParams,
  field: "groupPolicy" | "requireMention",
  read: (value: unknown) => T | undefined,
): { value: T; source: string } | undefined {
  for (const [config, sourceBase] of [
    [params.config, params.sourceBase],
    [params.inheritedConfig, params.inheritedSourceBase],
    [params.fallbackConfig, params.fallbackSourceBase],
  ] as const) {
    const value = read(config?.[field]);
    if (value !== undefined) {
      return { value, source: `${sourceBase}/${field}` };
    }
  }
  return undefined;
}

function channelImplicitGroupPolicy(params: ChannelIngressParams): {
  readonly source: string;
  readonly value: "allowlist" | "open";
} {
  const groups = effectiveNestedIngressContainer(params, "groups");
  if (groups !== undefined) {
    return { source: `${groups.sourceBase}/groups`, value: "allowlist" };
  }
  const fallbackGroups = isRecord(params.fallbackConfig?.groups)
    ? params.fallbackConfig.groups
    : undefined;
  if (fallbackGroups !== undefined && Object.keys(fallbackGroups).length > 0) {
    return { source: `${params.fallbackSourceBase}/groups`, value: "allowlist" };
  }
  return {
    source: `${params.sourceBase}/groupPolicy`,
    value: ALLOWLIST_DEFAULT_INGRESS_GROUP_POLICY_CHANNELS.has(params.channel)
      ? "allowlist"
      : "open",
  };
}

function pushChannelRequireMentionIngress(
  entries: PolicyIngressEvidence[],
  params: ChannelIngressParams,
  groupPolicy: string,
): void {
  const requireMention =
    channelWildcardRequireMention(params) ??
    channelIngressValue(params, "requireMention", readBoolean);
  const defaultRequireMention = !(
    groupPolicy === "open" && OPEN_GROUPS_DEFAULT_TO_NO_MENTION_CHANNELS.has(params.channel)
  );
  entries.push({
    id: channelIngressId(params, "require-mention"),
    kind: "channelRequireMention",
    source: requireMention?.source ?? `${params.sourceBase}/requireMention`,
    channel: params.channel,
    ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    value: requireMention?.value ?? defaultRequireMention,
    explicit: requireMention !== undefined,
  });

  for (const containerKey of ["groups", "guilds", "channels", "rooms", "teams"] as const) {
    const effective = effectiveNestedIngressContainer(params, containerKey);
    if (effective === undefined) {
      continue;
    }
    const { container, sourceBase } = effective;
    for (const [groupId, groupConfig] of Object.entries(container)) {
      if (!isRecord(groupConfig)) {
        continue;
      }
      pushNestedRequireMentionIngress(
        entries,
        params,
        containerKey,
        groupId,
        groupConfig,
        sourceBase,
      );
    }
  }
}

function channelWildcardRequireMention(
  params: ChannelIngressParams,
): { readonly source: string; readonly value: boolean } | undefined {
  for (const key of ["groups", "guilds", "channels", "rooms", "teams"] as const) {
    const effective = effectiveNestedIngressContainer(params, key);
    const fallback = {
      container: asNonArrayRecord(params.fallbackConfig?.[key]),
      sourceBase: params.fallbackSourceBase,
    };
    for (const candidate of [effective, fallback]) {
      const wildcard = candidate?.container["*"];
      if (!isRecord(wildcard) || wildcard.enabled === false) {
        continue;
      }
      const requireMention = readBoolean(wildcard.requireMention);
      if (requireMention !== undefined && candidate !== undefined) {
        return {
          source: `${candidate.sourceBase}/${key}/${ocPathSegment("*")}/requireMention`,
          value: requireMention,
        };
      }
    }
  }
  return undefined;
}

function effectiveNestedIngressContainer(
  params: ChannelIngressParams,
  key: "groups" | "guilds" | "channels" | "rooms" | "teams",
): { readonly container: Record<string, unknown>; readonly sourceBase: string } | undefined {
  const local = isRecord(params.config[key]) ? params.config[key] : undefined;
  const inherited = isRecord(params.inheritedConfig[key]) ? params.inheritedConfig[key] : undefined;
  if (local !== undefined && Object.keys(local).length > 0) {
    return { container: local, sourceBase: params.sourceBase };
  }
  const inheritsEmpty = local !== undefined && params.inheritEmptyNestedContainers === true;
  const inheritsMissing = local === undefined && params.inheritNestedContainers === true;
  if ((inheritsEmpty || inheritsMissing) && inherited !== undefined) {
    return { container: inherited, sourceBase: params.inheritedSourceBase };
  }
  return undefined;
}

function pushNestedRequireMentionIngress(
  entries: PolicyIngressEvidence[],
  params: ChannelIngressParams,
  containerKey: string,
  groupId: string,
  config: Record<string, unknown>,
  parentSourceBase: string,
): void {
  if (config.enabled === false) {
    return;
  }
  const sourceBase = `${parentSourceBase}/${containerKey}/${ocPathSegment(groupId)}`;
  const requireMention = readBoolean(config.requireMention);
  if (requireMention !== undefined) {
    entries.push({
      id: `${channelIngressId(params, `${containerKey}-${ocPathSegment(groupId)}`)}-require-mention`,
      kind: "channelRequireMention",
      source: `${sourceBase}/requireMention`,
      channel: params.channel,
      ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
      groupId,
      value: requireMention,
      explicit: true,
    });
  }
  for (const nestedKey of ["channels", "topics"] as const) {
    const nested = config[nestedKey];
    if (!isRecord(nested)) {
      continue;
    }
    for (const [nestedId, nestedConfig] of Object.entries(nested)) {
      if (isRecord(nestedConfig)) {
        pushNestedRequireMentionIngress(
          entries,
          params,
          `${containerKey}/${ocPathSegment(groupId)}/${nestedKey}`,
          nestedId,
          nestedConfig,
          parentSourceBase,
        );
      }
    }
  }
}

function channelDmPolicy(
  config: Record<string, unknown>,
  sourceBase: string,
): { readonly value: string; readonly source: string } | undefined {
  const dm = asNonArrayRecord(config.dm);
  if (dm.enabled === false) {
    return { value: "disabled", source: `${sourceBase}/dm/enabled` };
  }
  const direct = readString(config.dmPolicy);
  if (direct !== undefined) {
    return { value: direct, source: `${sourceBase}/dmPolicy` };
  }
  const legacy = readString(dm.policy);
  return legacy === undefined ? undefined : { value: legacy, source: `${sourceBase}/dm/policy` };
}

function channelIngressId(params: ChannelIngressParams, suffix: string): string {
  return params.accountId === undefined
    ? `${params.channel}-${suffix}`
    : `${params.channel}-${params.accountId}-${suffix}`;
}
