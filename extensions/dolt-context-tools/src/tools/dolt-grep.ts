import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { DoltReadOnlyQueryHelpers, SearchTurnPayloadMatch } from "../read-only-dolt-store.js";
import { buildNoContextDataMessage } from "./common.js";

/**
 * Build the dolt_grep tool for regex search across persisted turn payloads.
 */
export function createDoltGrepTool(params: { queries: DoltReadOnlyQueryHelpers }): AnyAgentTool {
  return {
    name: "dolt_grep",
    label: "Dolt Grep",
    description:
      "Regex search across raw turn message content in the Dolt store. Requires session_id (use the current session), optionally scopes under a leaf/bindle pointer, groups results by covering leaf, and supports pagination via page. Use dolt_expand on covering pointers for full context.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regex pattern to search for." }),
      session_id: Type.String({ description: "Session id to search." }),
      parent_pointer: Type.Optional(
        Type.String({ description: "Optional leaf/bindle pointer scope." }),
      ),
      page: Type.Optional(Type.Number({ description: "1-indexed page number." })),
    }),
    async execute(_id: string, rawParams: Record<string, unknown>) {
      const pattern = typeof rawParams.pattern === "string" ? rawParams.pattern.trim() : "";
      if (!pattern) {
        throw new Error("pattern required");
      }

      const sessionId = typeof rawParams.session_id === "string" ? rawParams.session_id.trim() : "";
      if (!sessionId) {
        throw new Error("session_id required");
      }

      const parentPointer =
        typeof rawParams.parent_pointer === "string" ? rawParams.parent_pointer.trim() : "";
      const page = normalizePage(rawParams.page);

      validateRegexPattern(pattern);

      const availability = params.queries.getAvailability();
      if (!availability.available) {
        return {
          content: [{ type: "text", text: buildNoContextDataMessage(availability) }],
          details: { pattern, sessionId, parentPointer: parentPointer || null, page, availability },
        };
      }

      const offset = (page - 1) * PAGE_SIZE;
      const matches = params.queries.searchTurnPayloads({
        sessionId,
        pattern,
        parentPointer: parentPointer || undefined,
        limit: PAGE_SIZE + 1,
        offset,
      });
      const pageMatches = matches.slice(0, PAGE_SIZE);
      const hasMoreInStore = matches.length > PAGE_SIZE;

      const groups = buildGroups({
        queries: params.queries,
        sessionId,
        matches: pageMatches,
      });
      const rendered = renderResultPage({
        pattern,
        sessionId,
        parentPointer: parentPointer || null,
        page,
        groups,
        emittedSourceCount: pageMatches.length,
        hasMoreInStore,
      });

      return {
        content: [
          {
            type: "text",
            text: rendered.text,
          },
        ],
        details: {
          pattern,
          sessionId,
          parentPointer: parentPointer || null,
          page,
          availability,
          resultCount: rendered.emittedResultCount,
          hasMore: rendered.hasMore,
          truncatedByBudget: rendered.truncatedByBudget,
        },
      };
    },
  };
}

const PAGE_SIZE = 50;
const OUTPUT_CHAR_BUDGET = 40_000;
const PREVIEW_CHAR_LIMIT = 200;
const UNCOMPACTED_GROUP_KEY = "(uncompacted turns)";

type MatchGroup = {
  key: string;
  level: string;
  active: boolean;
  tokenCount: number | null;
  matches: SearchTurnPayloadMatch[];
};

type RenderResultPageParams = {
  pattern: string;
  sessionId: string;
  parentPointer: string | null;
  page: number;
  groups: MatchGroup[];
  emittedSourceCount: number;
  hasMoreInStore: boolean;
};

function validateRegexPattern(pattern: string): void {
  try {
    new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex pattern "${pattern}": ${message}`);
  }
}

function buildGroups(params: {
  queries: DoltReadOnlyQueryHelpers;
  sessionId: string;
  matches: SearchTurnPayloadMatch[];
}): MatchGroup[] {
  const activeLeafPointers = new Set(
    params.queries.listActiveLane(params.sessionId, "leaf", true).map((entry) => entry.pointer),
  );
  const byGroup = new Map<string, MatchGroup>();

  for (const match of params.matches) {
    const groupKey = match.coveringLeafPointer ?? UNCOMPACTED_GROUP_KEY;
    let group = byGroup.get(groupKey);
    if (!group) {
      const coveringLeaf = match.coveringLeafPointer
        ? params.queries.getRecord(match.coveringLeafPointer)
        : null;
      group = {
        key: groupKey,
        level: coveringLeaf?.level ?? (match.coveringLeafPointer ? "leaf" : "turn"),
        active: match.coveringLeafPointer
          ? activeLeafPointers.has(match.coveringLeafPointer)
          : false,
        tokenCount: coveringLeaf?.tokenCount ?? null,
        matches: [],
      };
      byGroup.set(groupKey, group);
    }
    group.matches.push(match);
  }

  return Array.from(byGroup.values());
}

function renderResultPage(params: RenderResultPageParams): {
  text: string;
  emittedResultCount: number;
  hasMore: boolean;
  truncatedByBudget: boolean;
} {
  const lines: string[] = [];
  let used = 0;
  let truncatedByBudget = false;
  let emittedResultCount = 0;

  const append = (line: string): boolean => {
    const delta = line.length + 1;
    if (used + delta > OUTPUT_CHAR_BUDGET) {
      truncatedByBudget = true;
      return false;
    }
    lines.push(line);
    used += delta;
    return true;
  };

  append("## Dolt Grep Results");
  append(`Pattern: \`${params.pattern}\``);
  append(`Session: ${params.sessionId}`);
  if (params.parentPointer) {
    append(`[Scoped to: ${params.parentPointer}]`);
  }
  append(`Page: ${params.page}`);
  append("");

  if (params.groups.length === 0) {
    append("No matches found.");
    return {
      text: lines.join("\n"),
      emittedResultCount: 0,
      hasMore: false,
      truncatedByBudget,
    };
  }

  outer: for (const group of params.groups) {
    if (!append(`### Covered by: ${group.key}`)) {
      break;
    }
    if (
      !append(
        `[level=${group.level} active=${group.active} tokens=~${group.tokenCount ?? "unknown"}]`,
      )
    ) {
      break;
    }
    append("");
    for (const match of group.matches) {
      const role = match.role ?? "unknown";
      const preview = previewText(match.content || match.payloadJson || "(no content)");
      if (!append(`- [ts=${match.eventTsMs}] (${role}): ${preview}`)) {
        break outer;
      }
      emittedResultCount += 1;
    }
    append("");
  }

  const hasMoreWithinPage = emittedResultCount < params.emittedSourceCount;
  const hasMore = params.hasMoreInStore || hasMoreWithinPage;
  if (hasMore) {
    append("---");
    append(`More results available. Use page=${params.page + 1} to see more.`);
  }

  return {
    text: lines.join("\n"),
    emittedResultCount,
    hasMore,
    truncatedByBudget,
  };
}

function previewText(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= PREVIEW_CHAR_LIMIT) {
    return collapsed;
  }
  return `${collapsed.slice(0, PREVIEW_CHAR_LIMIT - 3)}...`;
}

function normalizePage(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value));
}
