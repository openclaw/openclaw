import { mapAllowlistResolutionInputs } from "openclaw/plugin-sdk/compat";
import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";
function findExactDirectoryMatches(matches, query) {
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
function pickBestGroupMatch(matches, query) {
  if (matches.length === 0) {
    return void 0;
  }
  const [exact] = findExactDirectoryMatches(matches, query);
  return exact ?? matches[0];
}
function pickBestUserMatch(matches, query) {
  if (matches.length === 0) {
    return void 0;
  }
  const exact = findExactDirectoryMatches(matches, query);
  if (exact.length === 1) {
    return exact[0];
  }
  return void 0;
}
function describeUserMatchFailure(matches, query) {
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
async function resolveMatrixTargets(params) {
  return await mapAllowlistResolutionInputs({
    inputs: params.inputs,
    mapInput: async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        return { input, resolved: false, note: "empty input" };
      }
      if (params.kind === "user") {
        if (trimmed.startsWith("@") && trimmed.includes(":")) {
          return { input, resolved: true, id: trimmed };
        }
        try {
          const matches = await listMatrixDirectoryPeersLive({
            cfg: params.cfg,
            query: trimmed,
            limit: 5
          });
          const best = pickBestUserMatch(matches, trimmed);
          return {
            input,
            resolved: Boolean(best?.id),
            id: best?.id,
            name: best?.name,
            note: best ? void 0 : describeUserMatchFailure(matches, trimmed)
          };
        } catch (err) {
          params.runtime?.error?.(`matrix resolve failed: ${String(err)}`);
          return { input, resolved: false, note: "lookup failed" };
        }
      }
      try {
        const matches = await listMatrixDirectoryGroupsLive({
          cfg: params.cfg,
          query: trimmed,
          limit: 5
        });
        const best = pickBestGroupMatch(matches, trimmed);
        return {
          input,
          resolved: Boolean(best?.id),
          id: best?.id,
          name: best?.name,
          note: matches.length > 1 ? "multiple matches; chose first" : void 0
        };
      } catch (err) {
        params.runtime?.error?.(`matrix resolve failed: ${String(err)}`);
        return { input, resolved: false, note: "lookup failed" };
      }
    }
  });
}
export {
  resolveMatrixTargets
};
