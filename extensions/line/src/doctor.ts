import { parseAccessGroupAllowFromEntry } from "openclaw/plugin-sdk/access-groups";
import { firstDefined } from "openclaw/plugin-sdk/allow-from";
import type {
  ChannelDoctorAdapter,
  ChannelDoctorEmptyAllowlistAccountContext,
} from "openclaw/plugin-sdk/channel-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeLineAllowEntry } from "./bot-access.js";
import {
  resolveExactLineGroupConfigKey,
  resolveLineGroupConfigEntry,
  resolveLineGroupLookupIds,
} from "./group-keys.js";

/** Which key supplied the allowlist a group actually resolves to. */
type AllowFromSource = "group" | "defaults" | "channel";

type LineGroupCoverage = {
  covered: boolean;
  referenceBacked: string[];
  /** Enabled groups with no sender allowlist anywhere in their resolved config. */
  uncovered: string[];
  /** Enabled groups whose resolved allowlist is empty, keyed by the key that supplies it. */
  empty: Record<AllowFromSource, string[]>;
};

const GROUP_DEFAULTS_KEY = "*";

function classifyAllowFrom(values?: unknown): { covered: boolean; referenced: boolean } {
  const entries = Array.isArray(values) ? values.map(normalizeLineAllowEntry).filter(Boolean) : [];
  return {
    covered: entries.some((entry) => parseAccessGroupAllowFromEntry(entry) === null),
    referenced: entries.some((entry) => parseAccessGroupAllowFromEntry(entry) !== null),
  };
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

function inspectLineGroupCoverage(params: {
  account: Record<string, unknown>;
  parent?: Record<string, unknown>;
  groupAllowFrom?: unknown;
}): LineGroupCoverage {
  const empty: Record<AllowFromSource, string[]> = { group: [], defaults: [], channel: [] };
  const entries = readGroupEntries(params.account, params.parent);
  const groups = Object.fromEntries(entries);
  const defaults = groups[GROUP_DEFAULTS_KEY];

  // A group with no entry of its own resolves to the defaults node alone.
  const defaultCoverage = classifyAllowFrom(
    firstDefined(defaults?.allowFrom, params.groupAllowFrom),
  );
  let covered = defaults?.enabled !== false && defaultCoverage.covered;
  const referenceBacked =
    defaults?.enabled !== false && defaultCoverage.referenced ? [GROUP_DEFAULTS_KEY] : [];

  const uncovered: string[] = [];
  for (const [id, group] of entries) {
    if (id === GROUP_DEFAULTS_KEY) {
      continue;
    }
    const groupId = resolveLineGroupLookupIds(id)[0];
    if (resolveExactLineGroupConfigKey({ groups, groupId }) !== id) {
      continue;
    }
    const effectiveGroup = resolveLineGroupConfigEntry(groups, { groupId });
    if (effectiveGroup?.enabled === false) {
      continue;
    }
    const allowlist = classifyAllowFrom(
      firstDefined(effectiveGroup?.allowFrom, params.groupAllowFrom),
    );
    if (allowlist.referenced) {
      referenceBacked.push(id);
    }
    if (allowlist.covered) {
      covered = true;
    } else if (allowlist.referenced) {
      continue;
    } else if (group.allowFrom !== undefined) {
      empty.group.push(id);
    } else if (defaults?.allowFrom !== undefined) {
      empty.defaults.push(id);
    } else if (params.groupAllowFrom !== undefined) {
      empty.channel.push(id);
    } else {
      uncovered.push(id);
    }
  }
  return { covered, referenceBacked, uncovered, empty };
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

function formatGroupIds(ids: string[]): string {
  return ids.map((id) => `"${id}"`).join(", ");
}

/** Name blocked groups when a working per-group allowlist makes the shared warning untrue. */
function collectLineEmptyAllowlistExtraWarnings(
  params: ChannelDoctorEmptyAllowlistAccountContext,
): string[] {
  if (!isLineGroupAllowlistScope(params)) {
    return [];
  }
  const { covered, referenceBacked, uncovered, empty } = readLineGroupCoverage(params);
  const warnings: string[] = [];

  if (referenceBacked.length > 0) {
    const single = referenceBacked.length === 1;
    warnings.push(
      `- ${params.prefix}.groups: ${single ? "group" : "groups"} ${formatGroupIds(referenceBacked)} ${single ? "uses" : "use"} access-group references. Doctor cannot verify their LINE sender membership here. Check the referenced access groups before relying on group access.`,
    );
  }

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

  // Reference-backed permissions are unknown here, so the shared all-groups claim
  // cannot replace warnings about groups with no sender list.
  if ((covered || referenceBacked.length > 0) && uncovered.length > 0) {
    const single = uncovered.length === 1;
    const otherGroups = referenceBacked.length > 0 ? "" : " while your other groups keep working";
    warnings.push(
      `- ${params.prefix}.groups: ${single ? "group" : "groups"} ${formatGroupIds(uncovered)} ${single ? "has" : "have"} no sender allowlist — messages there are silently dropped${otherGroups}. Add sender IDs under ${params.prefix}.groups.<id>.allowFrom, or under ${params.prefix}.groups."*".allowFrom to cover every group, or to ${params.prefix}.groupAllowFrom.`,
    );
  }

  return warnings;
}

export const lineDoctor: ChannelDoctorAdapter = {
  collectEmptyAllowlistExtraWarnings: collectLineEmptyAllowlistExtraWarnings,
  shouldSkipDefaultEmptyGroupAllowlistWarning: (params) => {
    if (!isLineGroupAllowlistScope(params)) {
      return false;
    }
    const { covered, referenceBacked } = readLineGroupCoverage(params);
    return covered || referenceBacked.length > 0;
  },
};
