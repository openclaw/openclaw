import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { AcquireConfiguredProviderLocalService } from "openclaw/plugin-sdk/embedding-providers";
import {
  asToolParamsRecord,
  type AnyAgentTool,
  resolveMemorySearchIndexConfig,
  type MemoryPromptSectionBuilder,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { TSchema } from "typebox";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";

export type MemoryToolOptions = {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  oneShotCliRun?: boolean;
  conversationRecall?: OpenClawPluginToolContext["conversationRecall"];
  activeProjectKeys?: readonly string[];
  acquireLocalService?: AcquireConfiguredProviderLocalService;
  runInBackgroundContext?: MemoryCoreRuntimeHost["runInBackgroundContext"];
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

type MemorySourceContract = Readonly<{
  files: string;
  search: string;
  citationsMode?: NonNullable<OpenClawConfig["memory"]>["citations"];
}>;

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
    ? {
        cfg,
        agentId,
        settings,
        sources: { ...resolveMemorySourceContract(settings), citationsMode: cfg.memory?.citations },
      }
    : null;
}

const SEARCH_CORPUS_OUTCOME_GUIDANCE =
  "Report recall as partial, unavailable, or stale on a top-level warning or action guidance, disabled=true, or stale=true. An optional corpus outcome of not-registered in a multi-corpus result without one is informational. If unsure after retrieval, say you checked.";
const SESSION_RECALL_GUIDANCE =
  "For session hits, if available use sessions_search with distinctive snippet text (sessionKey = transcript ID when known), then sessions_history with the returned sessionKey, messageId, and sessionId. With only history available, use a known session key or transcript ID, a small limit, and paginate. Without history, hits are snippets only. Search line numbers are not history offsets; never read raw transcript files.";
function describeMemoryCitations(mode: MemorySourceContract["citationsMode"]): string {
  return mode === "off"
    ? "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks."
    : "Citations: include Source: <path#line> when it helps the user verify memory snippets.";
}
const GET_READ_OUTCOME_GUIDANCE =
  "status=ok means the requested excerpt was read; status=not_found means every requested available corpus missed; status=error means the requested read failed, not that memory is disabled.";

export const MEMORY_SEARCH_TOOL_CONTRACT = {
  label: "Memory Search",
  name: "memory_search",
  parameters: MemorySearchSchema,
  prepareArguments: (args: unknown) => {
    const params = asToolParamsRecord(args);
    const aliases = [
      ["min_score", "minScore"],
      ["max_results", "maxResults"],
      ["limit", "maxResults"],
    ] as const;
    if (!aliases.some(([alias]) => Object.hasOwn(params, alias))) {
      return args;
    }
    const normalized = { ...params };
    // Precedence: maxResults > max_results > limit, even for invalid values validation must reject.
    for (const [alias, key] of aliases) {
      if (Object.hasOwn(normalized, alias) && !Object.hasOwn(normalized, key)) {
        normalized[key] = normalized[alias];
      }
      delete normalized[alias];
    }
    return normalized;
  },
  describe: ({ search, citationsMode }: MemorySourceContract) =>
    `Semantically search ${search} when an answer depends on prior work, decisions, dates, people, preferences, or todos not already present in the current turn. Do not repeat memory retrieval when supplied context fully answers the question. Omit \`corpus\` to search those configured sources. Use memory_get for only the needed lines of file hits. Session results are transcript search references, not readable memory-file paths. ${SESSION_RECALL_GUIDANCE} Optional \`corpus=wiki\` or \`corpus=all\` also searches registered compiled-wiki supplements; use \`corpus=all\` only when compiled wiki supplements are needed. \`corpus=memory\` restricts hits to indexed memory files (excludes session transcript chunks from ranking). \`corpus=sessions\` searches indexed session transcripts under the same visibility rules as session history tools and returns unavailable when semantic session indexing is disabled. ${SEARCH_CORPUS_OUTCOME_GUIDANCE} ${describeMemoryCitations(citationsMode)}`,
} as const;

export const MEMORY_GET_TOOL_CONTRACT = {
  label: "Memory Get",
  name: "memory_get",
  parameters: MemoryGetSchema,
  describe: ({ files, citationsMode }: MemorySourceContract) =>
    `Safe exact excerpt read from ${files}; read only the needed lines. Session transcript paths are unsupported. ${SESSION_RECALL_GUIDANCE} Defaults to a bounded excerpt when lines are omitted and includes truncation/continuation info when more content exists. \`corpus=wiki\` reads registered compiled-wiki supplements. ${GET_READ_OUTCOME_GUIDANCE} ${SEARCH_CORPUS_OUTCOME_GUIDANCE} ${describeMemoryCitations(citationsMode)}`,
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

  // Recall triggers and disclosure limits stay eager: Code Mode may defer tool descriptions.
  // Retrieval recipes live in those descriptions.
  const guidance = hasMemorySearch
    ? "Answer needs prior work, decisions, dates, people, preferences, or todos absent from this turn? Run memory_search; skip when supplied context fully answers."
    : "When an answer depends on prior work, decisions, dates, people, preferences, or todos not in this turn and points to a memory file, use memory_get. Skip it when supplied context fully answers.";
  return [
    "## Memory Recall",
    guidance,
    ...(citationsMode === "off" ? [describeMemoryCitations(citationsMode)] : []),
    "",
  ];
}

/** Ask agents to tag repository-specific curated entries with the run's safe project key. */
export function buildProjectMemoryWriteInstruction(projectKey: string | undefined): string[] {
  // Keys become HTML comments in curated Markdown, so line breaks or angle brackets are unsafe.
  return projectKey && !/[\r\n<>]/u.test(projectKey)
    ? [
        `For every repository-specific memory entry you write, add <!-- project: ${projectKey} --> on the same line. Do not project-scope user-level preferences, standing intents, or facts that are not specific to this repository.`,
        "",
      ]
    : [];
}
