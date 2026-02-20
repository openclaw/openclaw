import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import type { DoltReadOnlyQueryHelpers } from "../read-only-dolt-store.js";
import { buildNoContextDataMessage } from "./common.js";

/**
 * Build the dolt_describe tool.
 */
export function createDoltDescribeTool(params: {
  queries: DoltReadOnlyQueryHelpers;
}): AnyAgentTool {
  return {
    name: "dolt_describe",
    label: "Dolt Describe",
    description:
      "Use this to inspect what a Dolt pointer refers to. Shows level, session/tokens/time, active status, lineage (parents/children), and a content preview. For bindles, includes ghost summary details for evicted pointers. Useful before deciding whether to dolt_expand a pointer.",
    parameters: Type.Object({
      pointer: Type.String({ description: "Dolt pointer to inspect (turn/leaf/bindle)." }),
    }),
    async execute(_id: string, rawParams: Record<string, unknown>) {
      const pointer = typeof rawParams.pointer === "string" ? rawParams.pointer.trim() : "";
      if (!pointer) {
        throw new Error("pointer required");
      }

      const availability = params.queries.getAvailability();
      if (!availability.available) {
        return {
          content: [{ type: "text", text: buildNoContextDataMessage(availability) }],
          details: { pointer, availability },
        };
      }

      const record = params.queries.getRecord(pointer);
      if (!record) {
        return {
          content: [{ type: "text", text: `Pointer not found: ${pointer}` }],
          details: { pointer, availability, found: false },
        };
      }

      const parents = params.queries.listDirectParents(record.pointer);
      const children = params.queries.listDirectChildren(record.pointer);
      const laneEntries = params.queries.listActiveLane(record.sessionId, record.level, false);
      const laneEntry = laneEntries.find((entry) => entry.pointer === record.pointer);
      const isActive = laneEntry?.isActive ?? false;

      const lines = [
        "Dolt pointer metadata",
        `Pointer: ${record.pointer}`,
        `Level: ${record.level}`,
        `Session: ${record.sessionId}`,
        `Tokens: ~${record.tokenCount} tokens`,
        `Event time: ${formatIsoTime(record.eventTsMs)}`,
        `Active: ${formatBoolean(isActive)}`,
        `Finalized at reset: ${formatBoolean(record.finalizedAtReset)}`,
      ];

      if (record.level === "leaf") {
        const parentBindle = findParentPointerByLevel({
          parents,
          expectedLevel: "bindle",
          queries: params.queries,
        });
        const childTurns = children
          .filter((edge) => edge.childLevel === "turn")
          .map((edge) => edge.childPointer);
        lines.push(`Parent bindle: ${parentBindle ?? "none"}`);
        lines.push(`Child turns: ${childTurns.length > 0 ? childTurns.join(", ") : "none"}`);
        lines.push(`Child count: ${childTurns.length}`);
      }

      if (record.level === "bindle") {
        const childLeaves = children
          .filter((edge) => edge.childLevel === "leaf")
          .map((edge) => edge.childPointer);
        const ghostSummary = params.queries.getGhostSummary(record.pointer);
        lines.push(`Child leaves: ${childLeaves.length > 0 ? childLeaves.join(", ") : "none"}`);
        lines.push(`Child count: ${childLeaves.length}`);
        if (!ghostSummary?.summaryText) {
          lines.push("Ghost summary: none");
        } else {
          lines.push(`Ghost summary: ${truncate(ghostSummary.summaryText, 500)}`);
          lines.push(
            `Ghost token count: ${ghostSummary.tokenCount === null ? "unknown" : ghostSummary.tokenCount}`,
          );
        }
        lines.push(`Evicted: ${formatBoolean(laneEntry ? !laneEntry.isActive : false)}`);
      }

      if (record.level === "turn") {
        const parentLeaf = findParentPointerByLevel({
          parents,
          expectedLevel: "leaf",
          queries: params.queries,
        });
        const role = extractRole(record.payload);
        lines.push(`Parent leaf: ${parentLeaf ?? "none"}`);
        lines.push(`Role: ${role ?? "none"}`);
      }

      if (record.level === "leaf" || record.level === "bindle") {
        const summary = extractSummary(record.payload);
        if (summary) {
          lines.push(`Summary content: ${truncate(summary, 500)}`);
        }
      } else {
        const preview = extractTurnPreview(record.payload, record.payloadJson);
        lines.push(`Content preview: ${truncate(preview, 300)}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          pointer,
          availability,
          found: true,
          level: record.level,
          sessionId: record.sessionId,
          active: isActive,
          childCount: children.length,
          parentCount: parents.length,
        },
      };
    },
  };
}

function findParentPointerByLevel(params: {
  parents: Array<{ parentPointer: string }>;
  expectedLevel: "leaf" | "bindle";
  queries: DoltReadOnlyQueryHelpers;
}): string | null {
  for (const parent of params.parents) {
    const parentRecord = params.queries.getRecord(parent.parentPointer);
    if (parentRecord?.level === params.expectedLevel) {
      return parent.parentPointer;
    }
  }
  return null;
}

function extractSummary(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const summary = record.summary;
  return typeof summary === "string" && summary.trim().length > 0 ? summary : null;
}

function extractRole(payload: unknown): string | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  const role = record.role;
  return typeof role === "string" && role.trim().length > 0 ? role : null;
}

function extractTurnPreview(payload: unknown, payloadJson: string | null): string {
  if (typeof payload === "string") {
    return payload;
  }

  const record = asRecord(payload);
  if (!record) {
    return payloadJson ?? "";
  }

  const contentValue = record.content;
  if (typeof contentValue === "string") {
    return contentValue;
  }
  if (Array.isArray(contentValue)) {
    const parts = contentValue
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        const block = asRecord(entry);
        if (!block) {
          return "";
        }
        if (typeof block.text === "string") {
          return block.text;
        }
        if (typeof block.content === "string") {
          return block.content;
        }
        return "";
      })
      .filter((part) => part.length > 0);
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }

  return payloadJson ?? JSON.stringify(payload);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

function formatIsoTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "unknown";
  }
  return new Date(value).toISOString();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}
