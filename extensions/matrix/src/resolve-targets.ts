import type {
  ChannelDirectoryEntry,
  ChannelResolveKind,
  ChannelResolveResult,
} from "openclaw/plugin-sdk/channel-contract";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
// Matrix plugin module implements resolve targets behavior.
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";
import { isMatrixQualifiedUserId, normalizeMatrixMessagingTarget } from "./matrix/target-ids.js";

function normalizeLookupQuery(query: string): string {
  return normalizeOptionalLowercaseString(query) ?? "";
}

function findExactDirectoryMatches(
  matches: ChannelDirectoryEntry[],
  query: string,
): ChannelDirectoryEntry[] {
  const normalized = normalizeLookupQuery(query);
  if (!normalized) {
    return [];
  }
  return matches.filter((match) => {
    const id = normalizeOptionalLowercaseString(match.id);
    const name = normalizeOptionalLowercaseString(match.name);
    const handle = normalizeOptionalLowercaseString(match.handle);
    return normalized === id || normalized === name || normalized === handle;
  });
}

function pickBestDirectoryMatch(
  matches: ChannelDirectoryEntry[],
  query: string,
  kind: ChannelResolveKind,
): { best?: ChannelDirectoryEntry; note?: string } {
  const exact = findExactDirectoryMatches(matches, query);
  if (kind === "user") {
    return exact.length === 1
      ? { best: exact[0] }
      : {
          note:
            matches.length === 0
              ? "no matches"
              : exact.length > 1
                ? "multiple exact matches; use full Matrix ID"
                : "no exact match; use full Matrix ID",
        };
  }
  const candidates = exact.length > 0 ? exact : matches;
  return {
    best: candidates[0],
    note:
      candidates.length > 1
        ? `multiple ${exact.length > 0 ? "exact " : ""}matches; chose first`
        : undefined,
  };
}

async function readCachedMatches(
  cache: Map<string, ChannelDirectoryEntry[]>,
  query: string,
  lookup: (query: string) => Promise<ChannelDirectoryEntry[]>,
): Promise<ChannelDirectoryEntry[]> {
  const key = normalizeLookupQuery(query);
  if (!key) {
    return [];
  }
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const matches = await lookup(query.trim());
  cache.set(key, matches);
  return matches;
}

export async function resolveMatrixTargets(params: {
  cfg: unknown;
  accountId?: string | null;
  inputs: string[];
  kind: ChannelResolveKind;
  runtime?: RuntimeEnv;
}): Promise<ChannelResolveResult[]> {
  const results: ChannelResolveResult[] = [];
  const lookupCache = new Map<string, ChannelDirectoryEntry[]>();
  const lookup =
    params.kind === "user" ? listMatrixDirectoryPeersLive : listMatrixDirectoryGroupsLive;

  for (const input of params.inputs) {
    const trimmed = input.trim();
    if (!trimmed) {
      results.push({ input, resolved: false, note: "empty input" });
      continue;
    }
    const normalizedTarget = normalizeMatrixMessagingTarget(trimmed);
    if (
      normalizedTarget &&
      (params.kind === "user"
        ? isMatrixQualifiedUserId(normalizedTarget)
        : normalizedTarget.startsWith("!"))
    ) {
      results.push({ input, resolved: true, id: normalizedTarget });
      continue;
    }
    try {
      const matches = await readCachedMatches(lookupCache, trimmed, (query) =>
        lookup({
          cfg: params.cfg,
          accountId: params.accountId,
          query,
          limit: 5,
        }),
      );
      const { best, note } = pickBestDirectoryMatch(matches, trimmed, params.kind);
      results.push({
        input,
        resolved: Boolean(best?.id),
        id: best?.id,
        name: best?.name,
        note,
      });
    } catch (err) {
      params.runtime?.error?.(`matrix resolve failed: ${String(err)}`);
      results.push({ input, resolved: false, note: "lookup failed" });
    }
  }
  return results;
}
