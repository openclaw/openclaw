import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  asToolParamsRecord,
  type AnyAgentTool,
  resolveMemorySearchIndexConfig,
  type MemoryPromptSectionBuilder,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { TSchema } from "typebox";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";

export type MemoryToolOptions = {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  oneShotCliRun?: boolean;
  conversationRecall?: OpenClawPluginToolContext["conversationRecall"];
  activeProjectKeys?: readonly string[];
  acquireLocalService?: MemoryCoreAcquireLocalService;
};

const MemorySearchSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    maxResults: { type: "integer", minimum: 1 },
    minScore: { type: "number" },
    corpus: { type: "string", enum: ["memory", "wiki", "all", "sessions"] },
  },
  required: ["query"],
  additionalProperties: false,
} as const satisfies TSchema;

const MemoryGetSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    from: { type: "integer", minimum: 1 },
    lines: { type: "integer", minimum: 1 },
    corpus: { type: "string", enum: ["memory", "wiki", "all"] },
  },
  required: ["path"],
  additionalProperties: false,
} as const satisfies TSchema;

type MemorySourceContract = Readonly<{ files: string; search: string }>;

function resolveMemorySourceContract(
  settings: NonNullable<ReturnType<typeof resolveMemorySearchIndexConfig>>,
): MemorySourceContract {
  const files = [
    "MEMORY.md, USER.md, Markdown files recursively under memory/",
    settings.extraPaths.length > 0 ? "configured extra paths" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    files,
    search: settings.searchSources.includes("sessions")
      ? `${files}, indexed session transcripts`
      : files,
  };
}

export function resolveMemoryToolContext(options: MemoryToolOptions) {
  const cfg = options.getConfig ? options.getConfig() : options.config;
  if (!cfg) {
    return null;
  }
  const agentId = resolveSessionAgentIdStrict({
    sessionKey: options.agentSessionKey,
    config: cfg,
    agentId: options.agentId,
  });
  // Tool schemas and guidance need source policy; provider validation belongs to execution.
  const settings = resolveMemorySearchIndexConfig(cfg, agentId);
  return settings
    ? { cfg, agentId, settings, sources: resolveMemorySourceContract(settings) }
    : null;
}

const SEARCH_CORPUS_OUTCOME_GUIDANCE =
  "Corpus outcomes cover each requested corpus; only a top-level corpus warning means results are partial and must be surfaced to the user. An optional corpus outcome of not-registered in a multi-corpus result is informational.";
const GET_READ_OUTCOME_GUIDANCE =
  "status=ok means the requested excerpt was read; status=not_found means every requested available corpus missed; status=error means the requested read failed, not that memory is disabled.";

export const MEMORY_SEARCH_TOOL_CONTRACT = {
  label: "Memory Search",
  name: "memory_search",
  parameters: MemorySearchSchema,
  prepareArguments: (args: unknown) => {
    const params = asToolParamsRecord(args);
    if (!Object.hasOwn(params, "min_score") && !Object.hasOwn(params, "max_results")) {
      return args;
    }
    const normalized = { ...params };
    // Explicit camelCase values win, including invalid values that validation must reject.
    for (const [alias, key] of [
      ["min_score", "minScore"],
      ["max_results", "maxResults"],
    ] as const) {
      if (Object.hasOwn(normalized, alias)) {
        if (!Object.hasOwn(normalized, key)) {
          normalized[key] = normalized[alias];
        }
        delete normalized[alias];
      }
    }
    return normalized;
  },
  describe: ({ search }: MemorySourceContract) =>
    `Mandatory recall step: semantically search ${search} before answering questions about prior work, decisions, dates, people, preferences, or todos. Omit \`corpus\` to search those configured sources. Session results are transcript search references, not readable memory-file paths. Optional \`corpus=wiki\` or \`corpus=all\` also searches registered compiled-wiki supplements; use \`corpus=all\` only when compiled wiki supplements are needed. \`corpus=memory\` restricts hits to indexed memory files (excludes session transcript chunks from ranking). \`corpus=sessions\` searches indexed session transcripts under the same visibility rules as session history tools and returns unavailable when semantic session indexing is disabled. ${SEARCH_CORPUS_OUTCOME_GUIDANCE} If response has disabled=true or stale=true, tell the user and include the warning/action guidance.`,
} as const;

export const MEMORY_GET_TOOL_CONTRACT = {
  label: "Memory Get",
  name: "memory_get",
  parameters: MemoryGetSchema,
  describe: ({ files }: MemorySourceContract) =>
    `Safe exact excerpt read from ${files}. Session transcript paths are unsupported; use the available session-history workflow for session hits. Defaults to a bounded excerpt when lines are omitted and includes truncation/continuation info when more content exists. \`corpus=wiki\` reads registered compiled-wiki supplements. ${GET_READ_OUTCOME_GUIDANCE} ${SEARCH_CORPUS_OUTCOME_GUIDANCE}`,
} as const;

export type MemoryToolContract = (
  | typeof MEMORY_SEARCH_TOOL_CONTRACT
  | typeof MEMORY_GET_TOOL_CONTRACT
) & { prepareArguments?: AnyAgentTool["prepareArguments"] };

export function buildMemoryPromptSection({
  availableTools,
  citationsMode,
}: Parameters<MemoryPromptSectionBuilder>[0]): string[] {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");
  if (!hasMemorySearch && !hasMemoryGet) {
    return [];
  }

  // Code mode may defer tool descriptions; recall and disclosure policy must stay here.
  const guidance = hasMemorySearch
    ? `Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search without corpus to search the configured sources${
        hasMemoryGet ? "; for memory-file hits, use memory_get to pull only the needed lines" : ""
      }. Use corpus=all only when compiled wiki supplements are needed. If low confidence after search, say you checked.`
    : "Before answering anything about prior work, decisions, dates, people, preferences, or todos that point to a specific memory file: run memory_get to pull only the needed lines. If low confidence after reading, say you checked.";
  const sessionGuidance = !hasMemorySearch
    ? []
    : [
        availableTools.has("sessions_search")
          ? `For session hits, use sessions_search with distinctive snippet text (and sessionKey set to the transcript ID when known)${
              availableTools.has("sessions_history")
                ? ", then sessions_history with the returned sessionKey, messageId, and sessionId for a bounded sanitized excerpt"
                : "; exact session history is unavailable with the enabled tools"
            }.`
          : availableTools.has("sessions_history")
            ? "For session hits, use sessions_history with a known session key or transcript ID and a small limit; paginate its returned history metadata to locate the excerpt."
            : "Session hits are search snippets only; exact session history is unavailable with the enabled tools.",
        "Session search line numbers are not history offsets. Never read raw transcript files to expand session hits.",
      ];
  const outcomeGuidance =
    "Report recall as partial, unavailable, or stale when the result includes a top-level warning or action guidance, or explicitly sets disabled=true or stale=true. In a multi-corpus result without a top-level warning or action guidance, treat an optional corpus outcome of not-registered as informational.";
  const citationGuidance =
    citationsMode === "off"
      ? "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks."
      : "Citations: include Source: <path#line> when it helps the user verify memory snippets.";
  return ["## Memory Recall", guidance, ...sessionGuidance, outcomeGuidance, citationGuidance, ""];
}
