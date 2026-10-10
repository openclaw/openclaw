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
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";

const CLAUDE_CLI_RUNTIME_ID = "claude-cli";
const ANTHROPIC_WILDCARD_REF = "anthropic/*";

/** Builds one decisions-scoped check; catalog and configured refs are read once, on first use. */
export function createUnlistedClaudeCliWildcardCheck(params: {
  cfg: OpenClawConfig;
  agentId: string;
  entries: () => readonly ModelCatalogEntry[];
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
        .entries()
        .filter((row) => normalizeProviderId(row.provider) === CLAUDE_CLI_RUNTIME_ID)
        .map((row) => row.id),
    );
    configuredRefs ??= resolveConfiguredModelEntries({
      cfg: params.cfg,
      agentId: params.agentId,
    }).byKey;
    return !listed.has(modelId) && !configuredRefs.has(modelKey(provider, modelId));
  };
}
