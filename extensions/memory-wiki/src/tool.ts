// Memory Wiki plugin module implements tool behavior.
import path from "node:path";
import { optionalFiniteNumberSchema } from "openclaw/plugin-sdk/channel-actions";
import { shouldIncludeLongTermMemoryByDefault } from "openclaw/plugin-sdk/routing";
import { Type } from "typebox";
import type { AnyAgentTool, OpenClawConfig } from "../api.js";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import {
  WIKI_SEARCH_BACKENDS,
  WIKI_SEARCH_CORPORA,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import { getMemoryWikiPage, searchMemoryWiki, WIKI_SEARCH_MODES } from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { renderMemoryWikiStatus, resolveMemoryWikiStatus } from "./status.js";

function formatWikiToolReportPath(config: ResolvedMemoryWikiConfig, reportPath: string): string {
  const vaultRoot = path.resolve(config.vault.path);
  const resolvedReportPath = path.resolve(reportPath);
  const relativeReportPath = path.relative(vaultRoot, resolvedReportPath);
  if (
    !relativeReportPath ||
    relativeReportPath.startsWith("..") ||
    path.isAbsolute(relativeReportPath)
  ) {
    return reportPath;
  }
  return relativeReportPath.replace(/\\/g, "/");
}

const WikiStatusSchema = Type.Object({}, { additionalProperties: false });
const WikiLintSchema = Type.Object({}, { additionalProperties: false });
const WikiSearchBackendSchema = Type.Union(
  WIKI_SEARCH_BACKENDS.map((value) => Type.Literal(value)),
);
const WikiSearchCorpusSchema = Type.Union(WIKI_SEARCH_CORPORA.map((value) => Type.Literal(value)));
const WikiSearchModeSchema = Type.Union(WIKI_SEARCH_MODES.map((value) => Type.Literal(value)));
const WikiSearchSchema = Type.Object(
  {
    query: Type.String({ minLength: 1 }),
    maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
    backend: Type.Optional(WikiSearchBackendSchema),
    corpus: Type.Optional(WikiSearchCorpusSchema),
    mode: Type.Optional(WikiSearchModeSchema),
  },
  { additionalProperties: false },
);
const WikiGetSchema = Type.Object(
  {
    lookup: Type.String({ minLength: 1 }),
    fromLine: Type.Optional(Type.Integer({ minimum: 1 })),
    lineCount: Type.Optional(Type.Integer({ minimum: 1 })),
    backend: Type.Optional(WikiSearchBackendSchema),
    corpus: Type.Optional(WikiSearchCorpusSchema),
  },
  { additionalProperties: false },
);
const WikiClaimEvidenceSchema = Type.Object(
  {
    kind: Type.Optional(Type.String({ minLength: 1 })),
    sourceId: Type.Optional(Type.String({ minLength: 1 })),
    path: Type.Optional(Type.String({ minLength: 1 })),
    lines: Type.Optional(Type.String({ minLength: 1 })),
    weight: optionalFiniteNumberSchema({ minimum: 0 }),
    note: Type.Optional(Type.String({ minLength: 1 })),
    confidence: optionalFiniteNumberSchema({ minimum: 0, maximum: 1 }),
    privacyTier: Type.Optional(Type.String({ minLength: 1 })),
    updatedAt: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
const WikiClaimSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1 })),
    text: Type.String({ minLength: 1 }),
    status: Type.Optional(Type.String({ minLength: 1 })),
    confidence: optionalFiniteNumberSchema({ minimum: 0, maximum: 1 }),
    evidence: Type.Optional(Type.Array(WikiClaimEvidenceSchema)),
    updatedAt: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
const WikiApplySchema = Type.Object(
  {
    op: Type.Union([
      Type.Literal("create_synthesis"),
      Type.Literal("update_metadata"),
      Type.Literal("synthesis"),
      Type.Literal("metadata"),
    ]),
    title: Type.Optional(Type.String({ minLength: 1 })),
    body: Type.Optional(Type.String({ minLength: 1 })),
    lookup: Type.Optional(Type.String({ minLength: 1 })),
    sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    claims: Type.Optional(Type.Array(WikiClaimSchema)),
    contradictions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    questions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    confidence: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()])),
    status: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

async function syncImportedSourcesIfNeeded(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
) {
  await syncMemoryWikiImportedSources({ config, appConfig });
}

type WikiToolMemoryContext = {
  agentId?: string;
  agentSessionKey?: string;
  agentChatType?: string;
  sandboxed?: boolean;
};

function wikiSearchToolDescription(memoryContext: WikiToolMemoryContext): string {
  if (
    !shouldIncludeLongTermMemoryByDefault({
      sessionKey: memoryContext.agentSessionKey,
      chatType: memoryContext.agentChatType,
    })
  ) {
    return "On-demand wiki recall tool for shared sessions: search wiki pages and imported memory only when the user explicitly asks for long-term memory/wiki context or a visible session instruction requests it. Shared search may include the active memory corpus when enabled.";
  }
  return "Search wiki pages and, when shared search is enabled, the active memory corpus by title, path, id, or body text.";
}

function wikiGetToolDescription(memoryContext: WikiToolMemoryContext): string {
  if (
    !shouldIncludeLongTermMemoryByDefault({
      sessionKey: memoryContext.agentSessionKey,
      chatType: memoryContext.agentChatType,
    })
  ) {
    return "On-demand wiki exact-read tool for shared sessions: read wiki pages or imported memory only when the user explicitly asks for long-term memory/wiki context or a visible session instruction requests it. Shared search may fall back to the active memory corpus when enabled.";
  }
  return "Read a wiki page by id or relative path, or fall back to the active memory corpus when shared search is enabled.";
}

function canMutateWikiMemory(memoryContext: WikiToolMemoryContext): boolean {
  return shouldIncludeLongTermMemoryByDefault({
    sessionKey: memoryContext.agentSessionKey,
    chatType: memoryContext.agentChatType,
  });
}

async function syncWikiReadSnapshotIfAllowed(
  config: ResolvedMemoryWikiConfig,
  appConfig: OpenClawConfig | undefined,
  memoryContext: WikiToolMemoryContext,
): Promise<boolean> {
  if (!canMutateWikiMemory(memoryContext)) {
    return false;
  }
  await syncImportedSourcesIfNeeded(config, appConfig);
  return true;
}

function wikiRestrictedResult(toolName: "wiki_apply" | "wiki_lint" | "wiki_status") {
  return {
    content: [
      {
        type: "text" as const,
        text:
          toolName === "wiki_status"
            ? "wiki_status is limited in shared sessions because private wiki status can sync sources and expose private vault metadata. Use a private/direct session for full wiki status."
            : `${toolName} was not run because shared sessions cannot mutate private wiki memory. Use a private/direct session for durable personal wiki changes.`,
      },
    ],
    details: {
      action: "rejected",
      reason: "shared_session_explicit_only",
    },
  };
}

function wikiStatusToolDescription(memoryContext: WikiToolMemoryContext): string {
  if (!canMutateWikiMemory(memoryContext)) {
    return "Limited wiki status for shared sessions. Full private wiki vault status is disabled because it may sync sources and expose private vault metadata.";
  }
  return "Inspect the current memory wiki vault mode, health, and Obsidian CLI availability.";
}

function wikiLintToolDescription(memoryContext: WikiToolMemoryContext): string {
  if (!canMutateWikiMemory(memoryContext)) {
    return "Wiki lint writes private wiki reports and is disabled for shared sessions. Use a private/direct session before running durable wiki maintenance.";
  }
  return "Lint the wiki vault and surface structural issues, provenance gaps, contradictions, and open questions.";
}

function wikiApplyToolDescription(memoryContext: WikiToolMemoryContext): string {
  if (!canMutateWikiMemory(memoryContext)) {
    return "Wiki apply writes private wiki memory and is disabled for shared sessions. Use a private/direct session before applying durable wiki changes.";
  }
  return "Apply narrow wiki mutations for syntheses and page metadata without freeform markdown surgery.";
}

export function createWikiStatusTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_status",
    label: "Wiki Status",
    description: wikiStatusToolDescription(memoryContext),
    parameters: WikiStatusSchema,
    execute: async () => {
      if (!canMutateWikiMemory(memoryContext)) {
        return wikiRestrictedResult("wiki_status");
      }
      await syncImportedSourcesIfNeeded(config, appConfig);
      const status = await resolveMemoryWikiStatus(config, {
        appConfig,
      });
      return {
        content: [{ type: "text", text: renderMemoryWikiStatus(status) }],
        details: status,
      };
    },
  };
}

export function createWikiSearchTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_search",
    label: "Wiki Search",
    description: wikiSearchToolDescription(memoryContext),
    parameters: WikiSearchSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        query: string;
        maxResults?: number;
        backend?: ResolvedMemoryWikiConfig["search"]["backend"];
        corpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
        mode?: (typeof WIKI_SEARCH_MODES)[number];
      };
      const initializeVault = await syncWikiReadSnapshotIfAllowed(config, appConfig, memoryContext);
      const results = await searchMemoryWiki({
        config,
        appConfig,
        agentId: memoryContext.agentId,
        agentSessionKey: memoryContext.agentSessionKey,
        sandboxed: memoryContext.sandboxed,
        initializeVault,
        query: params.query,
        maxResults: params.maxResults,
        ...(params.backend ? { searchBackend: params.backend } : {}),
        ...(params.corpus ? { searchCorpus: params.corpus } : {}),
        ...(params.mode ? { mode: params.mode } : {}),
      });
      const text =
        results.length === 0
          ? "No wiki or memory results."
          : results
              .map(
                (result, index) =>
                  `${index + 1}. ${result.title} (${result.corpus}/${result.kind})\nPath: ${result.path}${typeof result.startLine === "number" && typeof result.endLine === "number" ? `\nLines: ${result.startLine}-${result.endLine}` : ""}${result.provenanceLabel ? `\nProvenance: ${result.provenanceLabel}` : ""}${result.matchedClaimId ? `\nClaim: ${result.matchedClaimId}` : ""}${result.evidenceKinds && result.evidenceKinds.length > 0 ? `\nEvidence: ${result.evidenceKinds.join(", ")}` : ""}\nSnippet: ${result.snippet}`,
              )
              .join("\n\n");
      return {
        content: [{ type: "text", text }],
        details: { results },
      };
    },
  };
}

export function createWikiLintTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_lint",
    label: "Wiki Lint",
    description: wikiLintToolDescription(memoryContext),
    parameters: WikiLintSchema,
    execute: async () => {
      if (!canMutateWikiMemory(memoryContext)) {
        return wikiRestrictedResult("wiki_lint");
      }
      await syncImportedSourcesIfNeeded(config, appConfig);
      const result = await lintMemoryWikiVault(config);
      const contradictions = result.issuesByCategory.contradictions.length;
      const openQuestions = result.issuesByCategory["open-questions"].length;
      const provenance = result.issuesByCategory.provenance.length;
      const errors = result.issues.filter((issue) => issue.severity === "error").length;
      const warnings = result.issues.filter((issue) => issue.severity === "warning").length;
      const reportPath = formatWikiToolReportPath(config, result.reportPath);
      const summary =
        result.issueCount === 0
          ? "No wiki lint issues."
          : [
              `Issues: ${result.issueCount} total (${errors} errors, ${warnings} warnings)`,
              `Contradictions: ${contradictions}`,
              `Open questions: ${openQuestions}`,
              `Provenance gaps: ${provenance}`,
              `Report: ${reportPath}`,
            ].join("\n");
      return {
        content: [{ type: "text", text: summary }],
        details: {
          issueCount: result.issueCount,
          issues: result.issues,
          issuesByCategory: result.issuesByCategory,
          reportPath,
        },
      };
    },
  };
}

export function createWikiApplyTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_apply",
    label: "Wiki Apply",
    description: wikiApplyToolDescription(memoryContext),
    parameters: WikiApplySchema,
    execute: async (_toolCallId, rawParams) => {
      if (!canMutateWikiMemory(memoryContext)) {
        return wikiRestrictedResult("wiki_apply");
      }
      const mutation = normalizeMemoryWikiMutationInput(rawParams);
      await syncImportedSourcesIfNeeded(config, appConfig);
      const result = await applyMemoryWikiMutation({ config, mutation });
      const action = result.changed ? "Updated" : "No changes for";
      const compileSummary =
        result.compile.updatedFiles.length > 0
          ? `Refreshed ${result.compile.updatedFiles.length} index file${result.compile.updatedFiles.length === 1 ? "" : "s"}.`
          : "Indexes unchanged.";
      return {
        content: [
          {
            type: "text",
            text: `${action} ${result.pagePath} via ${result.operation}. ${compileSummary}`,
          },
        ],
        details: result,
      };
    },
  };
}

export function createWikiGetTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_get",
    label: "Wiki Get",
    description: wikiGetToolDescription(memoryContext),
    parameters: WikiGetSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        lookup: string;
        fromLine?: number;
        lineCount?: number;
        backend?: ResolvedMemoryWikiConfig["search"]["backend"];
        corpus?: ResolvedMemoryWikiConfig["search"]["corpus"];
      };
      const initializeVault = await syncWikiReadSnapshotIfAllowed(config, appConfig, memoryContext);
      const result = await getMemoryWikiPage({
        config,
        appConfig,
        agentId: memoryContext.agentId,
        agentSessionKey: memoryContext.agentSessionKey,
        sandboxed: memoryContext.sandboxed,
        initializeVault,
        lookup: params.lookup,
        fromLine: params.fromLine,
        lineCount: params.lineCount,
        ...(params.backend ? { searchBackend: params.backend } : {}),
        ...(params.corpus ? { searchCorpus: params.corpus } : {}),
      });
      if (!result) {
        return {
          content: [{ type: "text", text: `Wiki page not found: ${params.lookup}` }],
          details: { found: false },
        };
      }
      return {
        content: [{ type: "text", text: result.content }],
        details: { found: true, ...result },
      };
    },
  };
}
