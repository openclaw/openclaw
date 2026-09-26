import path from "node:path";
import { optionalFiniteNumberSchema, stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { asNonArrayRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type Static } from "typebox";
import type { AnyAgentTool, OpenClawConfig } from "../api.js";
import { applyMemoryWikiMutation, normalizeMemoryWikiMutationInput } from "./apply.js";
import {
  WIKI_SEARCH_BACKENDS,
  WIKI_SEARCH_CORPORA,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { lintMemoryWikiVault } from "./lint.js";
import {
  collectMemoryWikiOpenItems,
  countMemoryWikiOpenItems,
  WIKI_OPEN_ITEM_KINDS,
} from "./open-items.js";
import { renderWikiMutationSummary, renderWikiSearchResults } from "./presentation.js";
import {
  createWikiPageVisibilityFilter,
  getMemoryWikiPage,
  searchMemoryWiki,
  WIKI_SEARCH_MODES,
} from "./query.js";
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
  signal?: AbortSignal,
) {
  await syncMemoryWikiImportedSources({
    config,
    appConfig,
    ...(signal ? { signal } : {}),
  });
}

type WikiToolMemoryContext = {
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  conversationRecall?: OpenClawPluginToolContext["conversationRecall"];
  signal?: AbortSignal;
};

// Bound wiki_open_items output: an omitted `limit` must not flush an entire
// vault's unresolved items into model context. The default keeps typical output
// under the repo's model-visible-text budget; the schema maximum is a hard cap
// so even an explicit caller cannot request an unbounded listing.
const WIKI_OPEN_ITEMS_DEFAULT_LIMIT = 20;
const WIKI_OPEN_ITEMS_MAX_LIMIT = 100;
// OpenClaw's provider conversion truncates tool-result text at 8,000
// characters. Keep the *combined* rendered text and structured details well
// below that boundary so the selected items stay intact in both representations.
const WIKI_OPEN_ITEMS_RESULT_MAX_CHARS = 7_000;
// Bound individual model-visible fields as well as the number of returned
// items. This prevents a single malformed or unusually long question/claim
// from consuming an unbounded share of an agent's context window.
const WIKI_OPEN_ITEM_TEXT_MAX_CHARS = 500;
const WIKI_OPEN_ITEM_VARIANTS_MAX_COUNT = 10;
const WIKI_OPEN_ITEM_RELATED_PATHS_MAX_COUNT = 20;
const WikiOpenItemsSchema = Type.Object(
  {
    kinds: Type.Optional(Type.Array(stringEnum(WIKI_OPEN_ITEM_KINDS), { minItems: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: WIKI_OPEN_ITEMS_MAX_LIMIT })),
    // Position in the filtered (post-`kinds`) item list to resume from. The
    // sole addressable continuation mechanism: without it, items beyond the
    // first page (whether cut by `limit` or by the result-size budget) are
    // permanently unreachable through this tool.
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);
type WikiOpenItemKind = (typeof WIKI_OPEN_ITEM_KINDS)[number];

type BoundedWikiOpenItemVariant = {
  text: string;
  status: string;
  pagePath: string;
  pageTitle: string;
  confidence?: number;
};

function truncateOpenItemText(value: string): string {
  if (value.length <= WIKI_OPEN_ITEM_TEXT_MAX_CHARS) {
    return value;
  }
  return `${truncateUtf16Safe(value, WIKI_OPEN_ITEM_TEXT_MAX_CHARS - 1)}…`;
}

function boundMemoryWikiOpenItem<
  T extends {
    kind: WikiOpenItemKind;
    text: string;
    pagePath: string;
    pageTitle: string;
    claimId?: string;
    variants?: Array<{
      text: string;
      status: string;
      pagePath: string;
      pageTitle: string;
      confidence?: number;
    }>;
    relatedPagePaths?: string[];
  },
>(item: T): T {
  return {
    ...item,
    text: truncateOpenItemText(item.text),
    pagePath: truncateOpenItemText(item.pagePath),
    pageTitle: truncateOpenItemText(item.pageTitle),
    ...(item.claimId ? { claimId: truncateOpenItemText(item.claimId) } : {}),
    ...(item.variants
      ? {
          variants: item.variants.slice(0, WIKI_OPEN_ITEM_VARIANTS_MAX_COUNT).map((variant) => {
            const bounded: BoundedWikiOpenItemVariant = {
              text: truncateOpenItemText(variant.text),
              status: truncateOpenItemText(variant.status),
              pagePath: truncateOpenItemText(variant.pagePath),
              pageTitle: truncateOpenItemText(variant.pageTitle),
            };
            if (typeof variant.confidence === "number") {
              bounded.confidence = variant.confidence;
            }
            return bounded;
          }),
        }
      : {}),
    ...(item.relatedPagePaths
      ? {
          relatedPagePaths: item.relatedPagePaths
            .slice(0, WIKI_OPEN_ITEM_RELATED_PATHS_MAX_COUNT)
            .map(truncateOpenItemText),
        }
      : {}),
  };
}

/**
 * Render the returned page of items as model-visible text. Always states the
 * caller's position and whether more items exist so a truthful "nothing
 * returned" (nothing at this offset) is never confused with a budget-clipped
 * "something exists but didn't fit" (skip forward with `nextOffset`).
 */
function renderMemoryWikiOpenItems(
  items: Array<{
    kind: string;
    text: string;
    pagePath: string;
    claimId?: string;
    confidence?: number;
  }>,
  page: { offset: number; filteredTotal: number; nextOffset?: number },
): string {
  if (items.length === 0) {
    if (page.filteredTotal <= page.offset) {
      return page.offset > 0
        ? `No open wiki items remain at offset ${page.offset} (${page.filteredTotal} total matched).`
        : "No open wiki items.";
    }
    // Items exist at this offset, but none fit the result-size budget — the
    // false-empty case: never render "No open wiki items" here.
    const remaining = page.filteredTotal - page.offset;
    return `${remaining} unresolved item(s) remain at offset ${page.offset}, but none fit within this response's size budget. Call again with offset: ${page.nextOffset ?? page.offset + 1} to skip ahead.`;
  }
  const body = items
    .map((item, index) => {
      const claimSuffix = item.claimId ? ` (claim ${item.claimId})` : "";
      const confidenceSuffix =
        typeof item.confidence === "number" ? ` (confidence ${item.confidence.toFixed(2)})` : "";
      return `${page.offset + index + 1}. [${item.kind}] ${item.text}\nPage: ${item.pagePath}${claimSuffix}${confidenceSuffix}`;
    })
    .join("\n\n");
  if (page.nextOffset === undefined) {
    return body;
  }
  const remaining = page.filteredTotal - page.nextOffset;
  return `${body}\n\n(${remaining} more item(s) available — call again with offset: ${page.nextOffset} to continue.)`;
}

function hasMemoryWikiOpenItemsResultBudget(
  items: ReturnType<typeof boundMemoryWikiOpenItem>[],
  vaultCounts: ReturnType<typeof countMemoryWikiOpenItems>,
): boolean {
  // The pagination footer line is short and bounded (well under the ~1,000
  // characters of headroom already reserved below the true 8,000-char
  // provider limit), so it is not counted against this per-item budget check.
  const text = renderMemoryWikiOpenItems(items, { offset: 0, filteredTotal: items.length });
  const details = {
    counts: countMemoryWikiOpenItems(items),
    vaultCounts,
    items,
  };
  return text.length + JSON.stringify(details).length <= WIKI_OPEN_ITEMS_RESULT_MAX_CHARS;
}

/**
 * A compact stand-in for an item whose full form (typically a
 * contradiction cluster with many variants) alone exceeds the result
 * budget even after per-field truncation. Drops the bulky `variants`/
 * `relatedPagePaths` content but keeps enough (`kind`, `pagePath`,
 * `pageTitle`, `claimId`) that a caller can open the page directly
 * instead of the item becoming an anonymous, unreachable skip.
 */
function locatorForOversizedOpenItem(item: {
  kind: WikiOpenItemKind;
  pagePath: string;
  pageTitle: string;
  claimId?: string;
}): ReturnType<typeof boundMemoryWikiOpenItem> {
  return boundMemoryWikiOpenItem({
    kind: item.kind,
    text: "(too large to include in this response — open the page directly to view the full item)",
    pagePath: item.pagePath,
    pageTitle: item.pageTitle,
    ...(item.claimId ? { claimId: item.claimId } : {}),
  });
}

export function createWikiStatusTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_status",
    label: "Wiki Status",
    description:
      "Inspect the current memory wiki vault mode, health, and Obsidian CLI availability.",
    parameters: WikiStatusSchema,
    execute: async () => {
      await syncImportedSourcesIfNeeded(config, appConfig, memoryContext.signal);
      const status = await resolveMemoryWikiStatus(config, {
        appConfig,
        callerAgentId: memoryContext.agentId,
      });
      return textResult(renderMemoryWikiStatus(status), status);
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
    description:
      "Search wiki pages and, when shared search is enabled, the active memory corpus by title, path, id, or body text.",
    parameters: WikiSearchSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as Static<typeof WikiSearchSchema>;
      await syncImportedSourcesIfNeeded(config, appConfig, memoryContext.signal);
      const results = await searchMemoryWiki({
        config,
        appConfig,
        agentId: memoryContext.agentId,
        agentSessionKey: memoryContext.agentSessionKey,
        sandboxed: memoryContext.sandboxed,
        conversationRecall: memoryContext.conversationRecall,
        query: params.query,
        maxResults: params.maxResults,
        ...(params.backend ? { searchBackend: params.backend } : {}),
        ...(params.corpus ? { searchCorpus: params.corpus } : {}),
        ...(params.mode ? { mode: params.mode } : {}),
      });
      return textResult(renderWikiSearchResults(results), { results });
    },
  };
}

export function createWikiLintTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  signal?: AbortSignal,
): AnyAgentTool {
  return {
    name: "wiki_lint",
    label: "Wiki Lint",
    description:
      "Lint the wiki vault and surface structural issues, provenance gaps, contradictions, and open questions.",
    parameters: WikiLintSchema,
    execute: async () => {
      await syncImportedSourcesIfNeeded(config, appConfig, signal);
      const result = await lintMemoryWikiVault(config, signal ? { signal } : undefined);
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
      return textResult(summary, {
        issueCount: result.issueCount,
        issues: result.issues,
        issuesByCategory: result.issuesByCategory,
        reportPath,
      });
    },
  };
}

export function createWikiOpenItemsTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  memoryContext: WikiToolMemoryContext = {},
): AnyAgentTool {
  return {
    name: "wiki_open_items",
    label: "Wiki Open Items",
    description:
      "List unresolved wiki items — open questions, contradictions, and low-confidence pages or claims — with their text and page location so they can be reviewed or resolved. Paginated via `offset`; the result states whether more items remain and, if so, the `offset` to pass next.",
    parameters: WikiOpenItemsSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as { kinds?: WikiOpenItemKind[]; limit?: number; offset?: number };
      await syncImportedSourcesIfNeeded(config, appConfig, memoryContext.signal);
      const result = await collectMemoryWikiOpenItems(
        config.vault.path,
        undefined,
        createWikiPageVisibilityFilter({
          appConfig,
          agentId: memoryContext.agentId,
          agentSessionKey: memoryContext.agentSessionKey,
          sandboxed: memoryContext.sandboxed,
        }),
      );
      const kindFilter = params.kinds && params.kinds.length > 0 ? new Set(params.kinds) : null;
      const filtered = kindFilter
        ? result.items.filter((item) => kindFilter.has(item.kind))
        : result.items;
      const offset = params.offset ?? 0;
      // Always cap output: apply the conservative default when `limit` is
      // omitted so a normal call cannot render (or retain in details.items) an
      // entire vault. The schema maximum bounds explicit callers.
      const limit = params.limit ?? WIKI_OPEN_ITEMS_DEFAULT_LIMIT;
      const windowed = filtered.slice(offset, offset + limit);
      const boundedItems: ReturnType<typeof boundMemoryWikiOpenItem>[] = [];
      for (const item of windowed) {
        const candidate = [...boundedItems, boundMemoryWikiOpenItem(item)];
        if (!hasMemoryWikiOpenItemsResultBudget(candidate, result.counts)) {
          // If nothing has been returned yet, this item alone (typically a
          // contradiction cluster with many variants) exceeds the budget even
          // after per-field truncation. Returning nothing would make it
          // permanently unreachable in identifiable form and would also
          // produce a `nextOffset` equal to the current `offset` — stuck
          // forever on the same item. Fall back to a compact locator so a
          // caller both learns what/where it is and still advances.
          if (boundedItems.length === 0) {
            const locator = locatorForOversizedOpenItem(item);
            if (hasMemoryWikiOpenItemsResultBudget([locator], result.counts)) {
              boundedItems.push(locator);
            }
          }
          break;
        }
        boundedItems.push(candidate.at(-1)!);
      }
      // Position in `filtered` right after everything actually returned
      // (full items and any oversized-item locators alike). `hasMore`
      // therefore reflects both `limit` slicing and result-budget clipping,
      // unlike a naive `boundedItems.length < windowed.length` check, which
      // misses items already excluded by the `.slice` above.
      const consumedThrough = offset + boundedItems.length;
      const hasMore = consumedThrough < filtered.length;
      const nextOffset = hasMore ? consumedThrough : undefined;
      const text = renderMemoryWikiOpenItems(boundedItems, {
        offset,
        filteredTotal: filtered.length,
        ...(nextOffset !== undefined ? { nextOffset } : {}),
      });
      return {
        content: [{ type: "text", text }],
        // counts describe the returned (filtered/limited) items; vaultCounts is
        // the unfiltered whole-vault tally so callers can tell the two apart.
        details: {
          counts: countMemoryWikiOpenItems(boundedItems),
          vaultCounts: result.counts,
          items: boundedItems,
          offset,
          hasMore,
          ...(nextOffset !== undefined ? { nextOffset } : {}),
        },
      };
    },
  };
}

export function createWikiApplyTool(
  config: ResolvedMemoryWikiConfig,
  appConfig?: OpenClawConfig,
  signal?: AbortSignal,
): AnyAgentTool {
  return {
    name: "wiki_apply",
    label: "Wiki Apply",
    description:
      "Apply narrow wiki mutations for syntheses and page metadata without freeform markdown surgery.",
    parameters: WikiApplySchema,
    execute: async (_toolCallId, rawParams) => {
      const mutation = normalizeMemoryWikiMutationInput(rawParams);
      await syncImportedSourcesIfNeeded(config, appConfig, signal);
      const result = await applyMemoryWikiMutation({
        config,
        mutation,
        ...(signal ? { signal } : {}),
      });
      return textResult(renderWikiMutationSummary(result), result);
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
    description:
      "Read a wiki page by id or relative path, or fall back to the active memory corpus when shared search is enabled.",
    parameters: WikiGetSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = asNonArrayRecord(rawParams) as Partial<Static<typeof WikiGetSchema>>;
      const lookup = typeof params.lookup === "string" ? params.lookup.trim() : "";
      if (!lookup) {
        return textResult("wiki_get requires a non-empty `lookup` path or id.", { found: false });
      }
      await syncImportedSourcesIfNeeded(config, appConfig, memoryContext.signal);
      const result = await getMemoryWikiPage({
        config,
        appConfig,
        agentId: memoryContext.agentId,
        agentSessionKey: memoryContext.agentSessionKey,
        sandboxed: memoryContext.sandboxed,
        conversationRecall: memoryContext.conversationRecall,
        lookup,
        fromLine: params.fromLine,
        lineCount: params.lineCount,
        ...(params.backend ? { searchBackend: params.backend } : {}),
        ...(params.corpus ? { searchCorpus: params.corpus } : {}),
      });
      if (!result) {
        return textResult(`Wiki page not found: ${lookup}`, { found: false });
      }
      return textResult(result.content, { found: true, ...result });
    },
  };
}
