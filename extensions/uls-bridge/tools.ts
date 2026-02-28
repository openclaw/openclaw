/**
 * ULS Bridge Plugin — Tools
 *
 * Defines agent-callable tools for interacting with the Unified Latent Space:
 *   - uls.retrieve_context
 *   - uls.write_memory
 *   - uls.set_scope
 *   - uls.redact
 *   - uls.explain_provenance
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { getUlsHub, type UlsScope } from "../../src/uls/index.js";

// ---------------------------------------------------------------------------
// uls.retrieve_context
// ---------------------------------------------------------------------------

export function createUlsRetrieveTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  const hub = getUlsHub();
  if (!hub) return null;

  return {
    name: "uls_retrieve_context",
    description:
      "Retrieve shared memory from the Unified Latent Space. Returns provenance-tagged records from other agents that match your query. Results are read-only observations.",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language query describing what context you need",
        },
        scope: {
          type: "string",
          enum: ["self", "team", "global"],
          description:
            "Memory scope to search: 'self' (own memories), 'team' (team-shared), 'global' (all shared)",
        },
        top_k: {
          type: "number",
          description: "Maximum number of records to return (default: 5)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tag filter",
        },
      },
      required: ["query"],
    },
    async execute(params: Record<string, unknown>): Promise<AgentToolResult> {
      const agentId = ctx.agentId ?? "unknown";
      const query = String(params.query ?? "");
      const scope = (params.scope as UlsScope) ?? "team";
      const topK = Number(params.top_k ?? 5);
      const tags = Array.isArray(params.tags) ? (params.tags as string[]) : undefined;

      try {
        const result = await hub.retrieve({
          agentId,
          query,
          scope,
          topK,
          tags,
        });

        if (result.records.length === 0) {
          return { output: "No matching shared memory records found." };
        }

        const formatted = result.records
          .map((r) => {
            const riskStr = r.riskFlags.length > 0 ? ` [RISK: ${r.riskFlags.join(", ")}]` : "";
            const ts = new Date(r.timestamp).toISOString();
            const summary = Object.entries(r.pPublic)
              .filter(([, v]) => v !== undefined && v !== null)
              .map(([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
              .join("\n");
            return `[${r.modality}] agent=${r.agentId} time=${ts}${riskStr}\n  provenance: tool=${r.provenance.sourceTool ?? "—"}, hash=${r.provenance.inputHash.slice(0, 12)}…\n  tags: ${r.tags.join(", ") || "none"}\n${summary}`;
          })
          .join("\n---\n");

        return { output: formatted };
      } catch (err) {
        return { output: `ULS retrieval error: ${String(err)}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// uls.write_memory
// ---------------------------------------------------------------------------

export function createUlsWriteTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  const hub = getUlsHub();
  if (!hub) return null;

  return {
    name: "uls_write_memory",
    description:
      "Write a structured memory record to the Unified Latent Space. Records are sanitized and projected before storage. Default scope is 'self'; escalate to 'team' or 'global' only when appropriate.",
    parameters: {
      type: "object" as const,
      properties: {
        modality: {
          type: "string",
          enum: ["tool_result", "user_msg", "system_event", "plan_step", "contradiction"],
          description: "Type of memory to store",
        },
        summary: {
          type: "string",
          description: "Structured summary of what happened (never dump raw data)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization and retrieval",
        },
        scope: {
          type: "string",
          enum: ["self", "team", "global"],
          description: "Sharing scope (default: 'self')",
        },
        details: {
          type: "object",
          description: "Structured details (key-value pairs, no raw dumps)",
        },
      },
      required: ["modality", "summary"],
    },
    async execute(params: Record<string, unknown>): Promise<AgentToolResult> {
      const agentId = ctx.agentId ?? "unknown";
      const modality = String(params.modality ?? "system_event");
      const summary = String(params.summary ?? "");
      const tags = Array.isArray(params.tags) ? (params.tags as string[]) : [];
      const scope = (params.scope as UlsScope) ?? "self";
      const details = (params.details as Record<string, unknown>) ?? {};

      try {
        const record = await hub.encode(
          {
            modality,
            summary,
            ...details,
            tags,
            scope,
            sourceTool: "uls_write_memory",
            sourceChannel: ctx.messageChannel,
          },
          agentId,
        );

        record.scope = scope;
        await hub.store(record);

        return {
          output: `Memory stored: id=${record.recordId}, scope=${record.scope}, modality=${record.modality}, risk_flags=[${record.riskFlags.join(", ")}]`,
        };
      } catch (err) {
        return { output: `ULS write error: ${String(err)}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// uls.set_scope
// ---------------------------------------------------------------------------

export function createUlsSetScopeTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  const hub = getUlsHub();
  if (!hub) return null;

  return {
    name: "uls_set_scope",
    description: "Change the sharing scope of an existing memory record. Requires authorization.",
    parameters: {
      type: "object" as const,
      properties: {
        record_id: { type: "string", description: "Record UUID to update" },
        scope: {
          type: "string",
          enum: ["self", "team", "global"],
          description: "New scope",
        },
      },
      required: ["record_id", "scope"],
    },
    async execute(params: Record<string, unknown>): Promise<AgentToolResult> {
      const agentId = ctx.agentId ?? "unknown";
      const recordId = String(params.record_id ?? "");
      const newScope = (params.scope as UlsScope) ?? "self";

      const store = hub.getStore();
      const record = store.getRecord(recordId);
      if (!record) {
        return { output: `Record not found: ${recordId}` };
      }
      if (record.agentId !== agentId) {
        return { output: `Denied: you can only change scope on your own records.` };
      }

      try {
        // Re-encode with new scope and re-store
        record.scope = newScope;
        await hub.store(record);
        return { output: `Scope updated to '${newScope}' for record ${recordId}.` };
      } catch (err) {
        return { output: `Scope change denied: ${String(err)}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// uls.redact
// ---------------------------------------------------------------------------

export function createUlsRedactTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  const hub = getUlsHub();
  if (!hub) return null;

  return {
    name: "uls_redact",
    description:
      "Redact a memory record you own — sets scope to 'self' and clears public projection.",
    parameters: {
      type: "object" as const,
      properties: {
        record_id: { type: "string", description: "Record UUID to redact" },
        reason: { type: "string", description: "Reason for redaction" },
      },
      required: ["record_id"],
    },
    async execute(params: Record<string, unknown>): Promise<AgentToolResult> {
      const agentId = ctx.agentId ?? "unknown";
      const recordId = String(params.record_id ?? "");

      const store = hub.getStore();
      const record = store.getRecord(recordId);
      if (!record) {
        return { output: `Record not found: ${recordId}` };
      }
      if (record.agentId !== agentId) {
        return { output: `Denied: you can only redact your own records.` };
      }

      record.scope = "self";
      record.pPublic = { redacted: true, reason: String(params.reason ?? "agent-initiated") };
      record.tags = [...record.tags.filter((t) => t !== "redacted"), "redacted"];
      await hub.store(record);

      return { output: `Record ${recordId} redacted.` };
    },
  };
}

// ---------------------------------------------------------------------------
// uls.explain_provenance
// ---------------------------------------------------------------------------

export function createUlsExplainProvenanceTool(
  ctx: OpenClawPluginToolContext,
): AnyAgentTool | null {
  const hub = getUlsHub();
  if (!hub) return null;

  return {
    name: "uls_explain_provenance",
    description: "Explain the provenance and trust signals of a shared memory record.",
    parameters: {
      type: "object" as const,
      properties: {
        record_id: { type: "string", description: "Record UUID to inspect" },
      },
      required: ["record_id"],
    },
    async execute(params: Record<string, unknown>): Promise<AgentToolResult> {
      const agentId = ctx.agentId ?? "unknown";
      const recordId = String(params.record_id ?? "");

      const store = hub.getStore();
      const record = store.getRecord(recordId);
      if (!record) {
        return { output: `Record not found: ${recordId}` };
      }

      const lines = [
        `Record: ${record.recordId}`,
        `Schema Version: ${record.schemaVersion}`,
        `Agent: ${record.agentId}`,
        `Timestamp: ${new Date(record.timestamp).toISOString()}`,
        `Modality: ${record.modality}`,
        `Scope: ${record.scope}`,
        `Tags: ${record.tags.join(", ") || "none"}`,
        `Risk Flags: ${record.riskFlags.join(", ") || "none"}`,
        `Provenance:`,
        `  Source Tool: ${record.provenance.sourceTool ?? "unknown"}`,
        `  Source Channel: ${record.provenance.sourceChannel ?? "unknown"}`,
        `  Input Hash: ${record.provenance.inputHash}`,
        `ACL:`,
        `  Allow: ${record.acl.allow?.join(", ") ?? "any"}`,
        `  Deny: ${record.acl.deny?.join(", ") ?? "none"}`,
        record.agentId === agentId
          ? `(You own this record)`
          : `(Owned by another agent — you see only p_public)`,
      ];

      return { output: lines.join("\n") };
    },
  };
}
