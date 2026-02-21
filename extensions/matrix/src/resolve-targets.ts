import type {
  ChannelDirectoryEntry,
  ChannelResolveKind,
  ChannelResolveResult,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";

function findExactDirectoryMatches(
  matches: ChannelDirectoryEntry[],
  query: string,
): ChannelDirectoryEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  return matches.filter((match) => {
    const id = match.id.trim().toLowerCase();
    const name = match.name?.trim().toLowerCase();
    const handle = match.handle?.trim().toLowerCase();
    return normalized === id || normalized === name || normalized === handle;
  });
}

function pickBestGroupMatch(
  matches: ChannelDirectoryEntry[],
  query: string,
): ChannelDirectoryEntry | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  const [exact] = findExactDirectoryMatches(matches, query);
  return exact ?? matches[0];
}

function pickBestUserMatch(
  matches: ChannelDirectoryEntry[],
  query: string,
): ChannelDirectoryEntry | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  const exact = findExactDirectoryMatches(matches, query);
  if (exact.length === 1) {
    return exact[0];
  }
  return undefined;
}

function describeUserMatchFailure(matches: ChannelDirectoryEntry[], query: string): string {
  if (matches.length === 0) {
    return "no matches";
  }
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return "empty input";
  }
  const exact = findExactDirectoryMatches(matches, normalized);
  if (exact.length === 0) {
    return "no exact match; use full Matrix ID";
  }
  if (exact.length > 1) {
    return "multiple exact matches; use full Matrix ID";
  }
  return "no exact match; use full Matrix ID";
}

export async function resolveMatrixTargets(params: {
  cfg: unknown;
  inputs: string[];
  kind: ChannelResolveKind;
  runtime?: RuntimeEnv;
}): Promise<ChannelResolveResult[]> {
  const results: ChannelResolveResult[] = [];
  for (const input of params.inputs) {
    const trimmed = input.trim();
    if (!trimmed) {
      results.push({ input, resolved: false, note: "empty input" });
      continue;
    }
    if (params.kind === "user") {
      if (trimmed.startsWith("@") && trimmed.includes(":")) {
        results.push({ input, resolved: true, id: trimmed });
        continue;
      }
      try {
        const matches = await listMatrixDirectoryPeersLive({
          cfg: params.cfg,
          query: trimmed,
          limit: 5,
        });
        const best = pickBestUserMatch(matches, trimmed);
        results.push({
          input,
          resolved: Boolean(best?.id),
          id: best?.id,
          name: best?.name,
          note: best ? undefined : describeUserMatchFailure(matches, trimmed),
        });
      } catch (err) {
        params.runtime?.error?.(`matrix resolve failed: ${String(err)}`);
        results.push({ input, resolved: false, note: "lookup failed" });
      }
      continue;
    }
    try {
      const matches = await listMatrixDirectoryGroupsLive({
        cfg: params.cfg,
        query: trimmed,
        limit: 5,
      });
      const best = pickBestGroupMatch(matches, trimmed);
      results.push({
        input,
        resolved: Boolean(best?.id),
        id: best?.id,
        name: best?.name,
        note: matches.length > 1 ? "multiple matches; chose first" : undefined,
      });
    } catch (err) {
      params.runtime?.error?.(`matrix resolve failed: ${String(err)}`);
      results.push({ input, resolved: false, note: "lookup failed" });
    }
  }
  return results;
}
