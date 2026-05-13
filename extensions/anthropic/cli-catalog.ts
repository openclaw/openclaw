import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS } from "./cli-constants.js";

// Claude CLI runs through the user's local CLI binary which authenticates via
// Claude.ai subscription OAuth (or an explicit API key); per-token billing
// metadata is not meaningful for this path — the subscription, not OpenClaw,
// owns cost. Models are seeded with subscription-appropriate defaults so the
// picker has consistent entries; runtime config can override per-ref.
const CLAUDE_CLI_DEFAULT_CONTEXT_WINDOW = 200_000;
const CLAUDE_CLI_DEFAULT_MAX_TOKENS = 64_000;

const CLAUDE_CLI_MODEL_LABELS: Record<string, string> = {
  "claude-opus-4-7": "Claude Opus 4.7 (Claude CLI)",
  "claude-opus-4-6": "Claude Opus 4.6 (Claude CLI)",
  "claude-opus-4-5": "Claude Opus 4.5 (Claude CLI)",
  "claude-sonnet-4-6": "Claude Sonnet 4.6 (Claude CLI)",
  "claude-sonnet-4-5": "Claude Sonnet 4.5 (Claude CLI)",
  "claude-haiku-4-5": "Claude Haiku 4.5 (Claude CLI)",
};

function buildClaudeCliModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: CLAUDE_CLI_MODEL_LABELS[id] ?? `${id} (Claude CLI)`,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: CLAUDE_CLI_DEFAULT_CONTEXT_WINDOW,
    maxTokens: CLAUDE_CLI_DEFAULT_MAX_TOKENS,
  };
}

function extractClaudeCliModelIds(): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const ref of CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS) {
    if (!ref.startsWith(`${CLAUDE_CLI_BACKEND_ID}/`)) {
      continue;
    }
    const id = ref.slice(CLAUDE_CLI_BACKEND_ID.length + 1);
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function buildClaudeCliProviderCatalog(): ModelProviderConfig {
  return {
    baseUrl: "claude-cli://local",
    api: "anthropic-messages",
    models: extractClaudeCliModelIds().map(buildClaudeCliModel),
  };
}
