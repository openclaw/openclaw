/**
 * Claude CLI sign-in writes `agents.*.models["anthropic/*"]` with the `claude-cli` runtime so any
 * typed Claude ID runs through Claude Code. In catalog decisions that wildcard lights up only the
 * models the Claude CLI catalog lists; authored rows keep their availability and typed refs still
 * run. Other provider wildcards are unchanged.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelKey } from "../shared/model-key.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { resolveConfiguredModelEntries } from "./configured-model-entries.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";

const CLAUDE_CLI_RUNTIME_ID = "claude-cli";
const ANTHROPIC_WILDCARD_REF = "anthropic/*";

/** Project the account menu onto canonical identities without admitting hosted-only models. */
export function projectClaudeCliNativeCatalog(
  snapshot: ModelCatalogSnapshot,
  cliOnly: boolean,
): ModelCatalogSnapshot {
  const listing = snapshot.providerOutcomes?.find(
    (outcome) => outcome.provider === CLAUDE_CLI_RUNTIME_ID && outcome.listedModelIds !== undefined,
  );
  const nativeOnly = cliOnly && listing !== undefined;
  const listed = new Set(listing?.listedModelIds ?? []);
  const nativeRows = snapshot.entries.filter(
    (entry) => entry.provider === CLAUDE_CLI_RUNTIME_ID && listed.has(entry.id),
  );
  const metadata = new Map(
    [...(snapshot.staticEntries ?? []), ...snapshot.entries]
      .filter((entry) => entry.provider === "anthropic")
      .map((entry) => [entry.id, entry]),
  );
  const enrichedNativeRows: ModelCatalogEntry[] = [];
  const canonical: ModelCatalogEntry[] = [];
  for (const entry of nativeRows) {
    const enriched = {
      ...entry,
      ...metadata.get(entry.id),
      id: entry.id,
      provider: CLAUDE_CLI_RUNTIME_ID,
      name: entry.name,
      reasoning: entry.reasoning,
      thinkingLevelMap: entry.thinkingLevelMap,
    };
    enrichedNativeRows.push(enriched);
    if (nativeOnly) {
      canonical.push({ ...enriched, provider: "anthropic" });
    }
  }
  const replaced = new Set(canonical.map((entry) => entry.id));
  const keep = (entry: ModelCatalogEntry) =>
    entry.provider !== CLAUDE_CLI_RUNTIME_ID &&
    !(entry.provider === "anthropic" && (nativeOnly || replaced.has(entry.id)));
  return {
    ...snapshot,
    entries: [...snapshot.entries.filter(keep), ...(nativeOnly ? canonical : enrichedNativeRows)],
    routeVariants: [...snapshot.routeVariants.filter(keep), ...enrichedNativeRows, ...canonical],
    staticEntries: snapshot.staticEntries?.filter(
      (entry) =>
        entry.provider !== CLAUDE_CLI_RUNTIME_ID && !(nativeOnly && entry.provider === "anthropic"),
    ),
  };
}

/** Builds one decisions-scoped check; catalog and configured refs are read once, on first use. */
export function createUnlistedClaudeCliWildcardCheck(params: {
  cfg: OpenClawConfig;
  agentId: string;
  outcomes: () => ModelCatalogSnapshot["providerOutcomes"];
}): (provider: string, modelId: string) => boolean {
  const wildcard =
    resolveAgentConfig(params.cfg, params.agentId)?.models?.[ANTHROPIC_WILDCARD_REF] ??
    params.cfg.agents?.defaults?.models?.[ANTHROPIC_WILDCARD_REF];
  if (normalizeProviderId(wildcard?.agentRuntime?.id ?? "") !== CLAUDE_CLI_RUNTIME_ID) {
    return () => false;
  }
  let listed: ReadonlySet<string> | undefined;
  let configuredRefs: ReadonlyMap<string, unknown> | undefined;
  return (provider, modelId) => {
    if (
      provider !== "anthropic" ||
      normalizeProviderId(
        resolveModelRuntimePolicy({
          config: params.cfg,
          provider,
          modelId,
          agentId: params.agentId,
        }).policy?.id ?? "",
      ) !== CLAUDE_CLI_RUNTIME_ID
    ) {
      return false;
    }
    listed ??= new Set(
      params
        .outcomes()
        ?.flatMap((outcome) =>
          outcome.provider === CLAUDE_CLI_RUNTIME_ID && outcome.listedModelIds !== undefined
            ? outcome.listedModelIds
            : [],
        ),
    );
    configuredRefs ??= resolveConfiguredModelEntries({
      cfg: params.cfg,
      agentId: params.agentId,
    }).byKey;
    return !listed.has(modelId) && !configuredRefs.has(modelKey(provider, modelId));
  };
}
