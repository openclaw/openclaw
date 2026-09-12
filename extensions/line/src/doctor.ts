// Line plugin module implements doctor behavior.
import { firstDefined } from "openclaw/plugin-sdk/allow-from";
import type {
  ChannelDoctorAdapter,
  ChannelDoctorEmptyAllowlistAccountContext,
} from "openclaw/plugin-sdk/channel-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

/** Which key supplied the allowlist a group actually resolves to. */
type AllowFromSource = "group" | "defaults" | "channel";

type LineGroupCoverage = {
  covered: boolean;
  /** Enabled groups with no sender allowlist anywhere in their resolved config. */
  uncovered: string[];
  /** Enabled groups whose resolved allowlist is empty, keyed by the key that supplies it. */
  empty: Record<AllowFromSource, string[]>;
};

const GROUP_DEFAULTS_KEY = "*";

function hasAllowFromEntries(values?: unknown): boolean {
  return Array.isArray(values) && values.length > 0;
}

/**
 * Read the group map one scope at a time, the way account resolution does.
 *
 * `mergeAccountConfig` spreads account keys over channel keys and LINE declares no
 * nested object keys, so an account that authors `groups` replaces the channel-level
 * map outright instead of merging entry by entry. Reading both scopes together would
 * credit an account with groups its runtime never sees.
 */
function readGroupEntries(
  account?: Record<string, unknown>,
  parent?: Record<string, unknown>,
): [string, Record<string, unknown>][] {
  const groups = isRecord(account?.groups) ? account.groups : parent?.groups;
  if (!isRecord(groups)) {
    return [];
  }
  return Object.entries(groups).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1]),
  );
}

/**
 * Group coverage as LINE's admission gate computes it.
 *
 * `resolveLineGroupConfigEntry` treats `groups["*"]` as a defaults node rather than a
 * rival entry, and admission reads `firstDefined(groupConfig.allowFrom, groupAllowFrom)`.
 * A group switched off with `enabled: false` is refused before any allowlist applies,
 * so it is neither covered nor a gap.
 */
function inspectLineGroupCoverage(params: {
  account: Record<string, unknown>;
  parent?: Record<string, unknown>;
  groupAllowFrom?: unknown;
}): LineGroupCoverage {
  const empty: Record<AllowFromSource, string[]> = { group: [], defaults: [], channel: [] };
  const entries = readGroupEntries(params.account, params.parent);
  if (entries.length === 0) {
    return { covered: false, uncovered: [], empty };
  }

  const defaults = entries.find(([id]) => id === GROUP_DEFAULTS_KEY)?.[1];
  const resolveAllowFrom = (
    group?: Record<string, unknown>,
  ): { value: unknown; source?: AllowFromSource } => {
    if (group?.allowFrom !== undefined) {
      return { value: group.allowFrom, source: group === defaults ? "defaults" : "group" };
    }
    if (defaults?.allowFrom !== undefined) {
      return { value: defaults.allowFrom, source: "defaults" };
    }
    if (params.groupAllowFrom !== undefined) {
      return { value: params.groupAllowFrom, source: "channel" };
    }
    return { value: undefined };
  };

  // A group with no entry of its own resolves to the defaults node alone.
  let covered =
    defaults?.enabled !== false && hasAllowFromEntries(resolveAllowFrom(defaults).value);

  const uncovered: string[] = [];
  for (const [id, group] of entries) {
    if (id === GROUP_DEFAULTS_KEY) {
      continue;
    }
    if (firstDefined(group.enabled, defaults?.enabled) === false) {
      continue;
    }
    const { value, source } = resolveAllowFrom(group);
    if (hasAllowFromEntries(value)) {
      covered = true;
    } else if (source === undefined) {
      uncovered.push(id);
    } else {
      // The remedy depends on which key supplies the empty list: the group's own
      // entry, the defaults node, or the channel-wide list.
      empty[source].push(id);
    }
  }
  return { covered, uncovered, empty };
}

function readLineGroupCoverage(
  params: ChannelDoctorEmptyAllowlistAccountContext,
): LineGroupCoverage {
  const { account, parent } = params;
  return inspectLineGroupCoverage({
    account,
    ...(parent ? { parent } : {}),
    groupAllowFrom: firstDefined(account.groupAllowFrom, parent?.groupAllowFrom),
  });
}

function readGroupPolicy(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isLineGroupAllowlistScope(params: ChannelDoctorEmptyAllowlistAccountContext): boolean {
  return (
    params.channelName === "line" &&
    (readGroupPolicy(params.account.groupPolicy) ?? readGroupPolicy(params.parent?.groupPolicy)) ===
      "allowlist"
  );
}

/**
 * Replace the shared warning when per-group allowlists make its claim untrue.
 *
 * The shared warning states every group message is dropped, which stops being true once
 * one group carries its own `allowFrom`. Suppressing it alone would hide the groups that
 * really are dropped, so name those here instead.
 */
function formatGroupIds(ids: string[]): string {
  return ids.map((id) => `"${id}"`).join(", ");
}

function collectLineEmptyAllowlistExtraWarnings(
  params: ChannelDoctorEmptyAllowlistAccountContext,
): string[] {
  if (!isLineGroupAllowlistScope(params)) {
    return [];
  }
  const { covered, uncovered, empty } = readLineGroupCoverage(params);
  const warnings: string[] = [];

  const dropped = (ids: string[]) =>
    `- ${params.prefix}.groups: ${ids.length === 1 ? "group" : "groups"} ${formatGroupIds(ids)} ${ids.length === 1 ? "resolves" : "resolve"} to an empty sender allowlist — messages there are silently dropped.`;

  if (empty.group.length > 0) {
    warnings.push(
      `${dropped(empty.group)} The empty list is authored on ${empty.group.length === 1 ? "that entry" : "those entries"} and overrides every wider list, so add sender IDs there, or remove the allowFrom key to inherit.`,
    );
  }
  if (empty.defaults.length > 0) {
    warnings.push(
      `${dropped(empty.defaults)} The empty list comes from ${params.prefix}.groups."*".allowFrom, so add sender IDs to that entry, or give ${empty.defaults.length === 1 ? "the group" : "each group"} its own allowFrom.`,
    );
  }
  if (empty.channel.length > 0) {
    warnings.push(
      `${dropped(empty.channel)} The empty list comes from ${params.prefix}.groupAllowFrom, so add sender IDs there, or give ${empty.channel.length === 1 ? "the group" : "each group"} its own allowFrom.`,
    );
  }

  // When nothing is served the shared warning already states the whole channel is
  // dropping group messages, so only the narrower cases are worth adding.
  if (covered && uncovered.length > 0) {
    const single = uncovered.length === 1;
    warnings.push(
      `- ${params.prefix}.groups: ${single ? "group" : "groups"} ${formatGroupIds(uncovered)} ${single ? "has" : "have"} no sender allowlist — messages there are silently dropped while your other groups keep working. Add sender IDs under ${params.prefix}.groups.<id>.allowFrom, or under ${params.prefix}.groups."*".allowFrom to cover every group, or to ${params.prefix}.groupAllowFrom.`,
    );
  }

  return warnings;
}

export const lineDoctor: ChannelDoctorAdapter = {
  collectEmptyAllowlistExtraWarnings: collectLineEmptyAllowlistExtraWarnings,
  shouldSkipDefaultEmptyGroupAllowlistWarning: (params) =>
    isLineGroupAllowlistScope(params) && readLineGroupCoverage(params).covered,
};
