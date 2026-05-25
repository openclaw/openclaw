import { buildAlarmSummary } from "../../claworks/alarm-summary.js";
import { bridgeImMessage } from "../../claworks/im-bridge.js";
import { applyIngressPublish } from "../../claworks/ingress-publish.js";
import { reloadClaworksPacksFromDisk } from "../../claworks/pack-runtime.js";
import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { ingestKbFolder } from "../../planes/data/kb-folder-ingest.js";
import { describeKnowledgeBase } from "../../planes/data/kb-status.js";
import {
  isDocumentKnowledgeBase,
  type KbDocumentStatus,
  type KbLayer,
} from "../../planes/data/kb-types.js";

function requireDocumentKb(runtime: ClaworksRuntime) {
  if (!isDocumentKnowledgeBase(runtime.kb)) {
    throw new Error("Document KB layer is required");
  }
  return runtime.kb;
}

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const CLAWORKS_MCP_TOOLS: McpToolDef[] = [
  {
    name: "cw_publish_event",
    description: "Publish an event to the ClaWorks EventKernel",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string" },
        source: { type: "string" },
        payload: { type: "object" },
      },
      required: ["type"],
    },
  },
  {
    name: "cw_trigger_playbook",
    description: "Trigger a playbook by id",
    inputSchema: {
      type: "object",
      properties: {
        playbook_id: { type: "string" },
        input: { type: "object" },
      },
      required: ["playbook_id"],
    },
  },
  {
    name: "cw_reload_packs",
    description: "Reload all installed packs from disk",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cw_kb_status",
    description: "Describe knowledge base provider and vector configuration",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cw_kb_search",
    description: "Search the knowledge base",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        namespace: { type: "string" },
        layer: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "cw_kb_list_documents",
    description: "List KB documents with optional status/layer/namespace filters",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        layer: { type: "string" },
        namespace: { type: "string" },
        q: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "cw_kb_get_document",
    description: "Get a KB document by id including chunks",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "cw_kb_ingest_document",
    description: "Ingest text as a draft or auto-published KB document",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        title: { type: "string" },
        source: { type: "string" },
        namespace: { type: "string" },
        layer: { type: "string" },
        doc_type: { type: "string" },
        auto_publish: { type: "boolean" },
      },
      required: ["text"],
    },
  },
  {
    name: "cw_kb_publish",
    description: "Publish a lint-clean KB document",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "cw_kb_lint_document",
    description: "Lint a KB document before publish",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "cw_kb_create_ingest_job",
    description: "Create a batch KB ingest job (folder, file, or inline text)",
    inputSchema: {
      type: "object",
      properties: {
        folder_path: { type: "string" },
        source_path: { type: "string" },
        text: { type: "string" },
        title: { type: "string" },
        source: { type: "string" },
        namespace: { type: "string" },
        layer: { type: "string" },
        doc_type: { type: "string" },
        auto_publish: { type: "boolean" },
      },
    },
  },
  {
    name: "cw_kb_process_ingest_job",
    description: "Process a pending KB ingest job",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  {
    name: "cw_kb_ingest",
    description: "Ingest text into the knowledge base",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        namespace: { type: "string" },
        source: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "cw_kb_flush",
    description: "Flush pending KB index updates (memory-core sync)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cw_kb_ingest_folder",
    description: "Batch-ingest files from a folder into the knowledge base",
    inputSchema: {
      type: "object",
      properties: {
        folder_path: { type: "string" },
        namespace: { type: "string" },
        recursive: { type: "boolean" },
        source_prefix: { type: "string" },
      },
      required: ["folder_path"],
    },
  },
  {
    name: "cw_agent_chat",
    description: "Platform agent chat completion",
    inputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          items: {
            type: "object",
            properties: { role: { type: "string" }, content: { type: "string" } },
          },
        },
        model: { type: "string" },
      },
      required: ["messages"],
    },
  },
  {
    name: "cw_query_objects",
    description: "Query ObjectStore by type",
    inputSchema: {
      type: "object",
      properties: { type_name: { type: "string" }, limit: { type: "number" } },
      required: ["type_name"],
    },
  },
  {
    name: "cw_list_playbooks",
    description: "List loaded playbooks",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cw_health",
    description: "Robot health and doctor checks",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cw_get_identity",
    description: "Get robot identity summary",
    inputSchema: {
      type: "object",
      properties: { include_agent_md: { type: "boolean" } },
    },
  },
  {
    name: "cw_bridge_im_message",
    description: "Bridge an IM message into ClaWorks EventKernel",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        message_id: { type: "string" },
        user_id: { type: "string" },
        text: { type: "string" },
        group_id: { type: "string" },
        extra: { type: "object" },
      },
      required: ["channel", "text"],
    },
  },
  {
    name: "cw_list_runs",
    description: "List playbook runs",
    inputSchema: {
      type: "object",
      properties: {
        playbook_id: { type: "string" },
        status: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "cw_get_run",
    description: "Get a single playbook run by id",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
  },
  {
    name: "cw_submit_hitl",
    description: "Submit HITL decision for a waiting run",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        step_id: { type: "string" },
        decision: { type: "string" },
        comment: { type: "string" },
      },
      required: ["run_id", "step_id", "decision"],
    },
  },
  {
    name: "list_pending_hitl",
    description: "List playbook runs awaiting human approval (remote bridge alias)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_alarm_summary",
    description: "Active alarm counts by severity (remote bridge alias)",
    inputSchema: {
      type: "object",
      properties: { station_id: { type: "string" } },
    },
  },
  {
    name: "list_object_types",
    description: "List ontology object types (remote bridge alias)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_kb",
    description: "Search knowledge base (remote bridge alias)",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
  },
  {
    name: "query_objects",
    description: "Query ObjectStore (remote bridge alias)",
    inputSchema: {
      type: "object",
      properties: {
        type_name: { type: "string" },
        filters: { type: "object" },
        limit: { type: "number" },
      },
      required: ["type_name"],
    },
  },
  {
    name: "cw_list_capabilities",
    description:
      "List all registered robot capabilities with their schemas and constitution decisions",
    inputSchema: {
      type: "object",
      properties: {
        verb: { type: "string", description: "Filter by verb (query/deliver/control/...)" },
        owner_kind: { type: "string", description: "Filter by owner kind (core/pack/bridge)" },
      },
    },
  },
  {
    name: "cw_invoke_capability",
    description: "Invoke a registered capability by id with params, enforcing robot constitution",
    inputSchema: {
      type: "object",
      required: ["capability_id"],
      properties: {
        capability_id: { type: "string" },
        params: { type: "object" },
        source: { type: "string", description: "Caller source (mcp/rest/playbook/...)" },
        user_id: { type: "string" },
      },
    },
  },
  {
    name: "cw_check_constitution",
    description:
      "Check whether a capability would be allowed/hitl/denied by the robot constitution",
    inputSchema: {
      type: "object",
      required: ["capability_id"],
      properties: {
        capability_id: { type: "string" },
        source: { type: "string" },
        user_id: { type: "string" },
      },
    },
  },
];

export async function callClaworksMcpTool(
  runtime: ClaworksRuntime,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // 先尝试 capability 工具
  if (
    name === "cw_list_capabilities" ||
    name === "cw_invoke_capability" ||
    name === "cw_check_constitution"
  ) {
    const { CapabilityDenied, CapabilityHitlRequired, CapabilityNotFound } =
      await import("../../kernel/capability-registry.js");

    switch (name) {
      case "cw_list_capabilities": {
        const all = runtime.capabilities.list();
        const verb = args.verb ? String(args.verb) : undefined;
        const ownerKind = args.owner_kind ? String(args.owner_kind) : undefined;
        const filtered = all.filter((c) => {
          if (verb && c.verb !== verb) {
            return false;
          }
          if (ownerKind && c.owner.kind !== ownerKind) {
            return false;
          }
          return true;
        });
        return { capabilities: filtered, total: filtered.length };
      }
      case "cw_invoke_capability": {
        const capId = String(args.capability_id ?? "");
        const params = (args.params as Record<string, unknown> | undefined) ?? {};
        const source = String(args.source ?? "mcp");
        const userId = args.user_id ? String(args.user_id) : undefined;
        const ctx: Parameters<typeof runtime.capabilities.invoke>[1] = {
          source,
          subjectId: userId ?? "mcp:agent",
          subjectType: "mcp",
          invoke: (id, p) =>
            runtime.capabilities.invoke(id, ctx, p, { constitutionCheck: { source, userId } }),
          logger: runtime.logger,
        };
        try {
          const result = await runtime.capabilities.invoke(capId, ctx, params, {
            constitutionCheck: { source, userId },
          });
          return { status: "ok", result };
        } catch (err) {
          if (err instanceof CapabilityNotFound) {
            return { status: "not_found", capability_id: capId };
          }
          if (err instanceof CapabilityDenied) {
            return { status: "denied", reason: err.message, tier: err.tier };
          }
          if (err instanceof CapabilityHitlRequired) {
            return { status: "hitl_required", reason: err.message, tier: err.tier };
          }
          throw err;
        }
      }
      case "cw_check_constitution":
        return {
          capability_id: String(args.capability_id ?? ""),
          ...(runtime.constitution?.check(String(args.capability_id ?? ""), {
            source: args.source ? String(args.source) : undefined,
            userId: args.user_id ? String(args.user_id) : undefined,
          }) ?? { action: "allow", tier: 0, reason: "constitution unavailable" }),
        };
    }
  }

  switch (name) {
    case "cw_publish_event": {
      const eventType = String(args.type ?? "custom.event");
      const subjectId = String(args.subject_id ?? "mcp:agent");
      const publishResult = await applyIngressPublish(runtime, {
        source: "mcp",
        eventType,
        subjectId,
        payload: (args.payload ?? {}) as Record<string, unknown>,
        publishSource: String(args.source ?? "mcp"),
        subjectType: "system",
      });
      if (publishResult.action === "denied") {
        return { action: "denied", reason: publishResult.reason };
      }
      if (publishResult.action === "observe_only") {
        return { action: "observe_only" };
      }
      if (publishResult.action === "intent_routed") {
        return {
          action: "intent_routed",
          playbook_id: publishResult.playbookId,
          run_id: publishResult.runId,
          status: publishResult.status,
        };
      }
      return {
        action: "published",
        event_type: publishResult.eventType,
        matched_playbooks: publishResult.matchedPlaybooks,
      };
    }
    case "cw_trigger_playbook": {
      const run = await runtime.playbookEngine.trigger(
        String(args.playbook_id ?? ""),
        (args.input ?? {}) as Record<string, unknown>,
      );
      return { run_id: run.id, status: run.status };
    }
    case "cw_reload_packs": {
      const { packs } = await reloadClaworksPacksFromDisk(runtime);
      return {
        status: "ok",
        total: packs.length,
        pack_ids: packs.map((p) => p.manifest.id),
      };
    }
    case "cw_kb_status":
      return describeKnowledgeBase(runtime.kb, runtime.config.data);
    case "cw_kb_search":
      return {
        results: await runtime.kb.search(String(args.query ?? ""), {
          limit: typeof args.limit === "number" ? args.limit : 5,
          namespace: args.namespace ? String(args.namespace) : undefined,
          layer: args.layer ? String(args.layer) : undefined,
        }),
      };
    case "cw_kb_list_documents":
      return {
        documents: await requireDocumentKb(runtime).listDocuments({
          status: args.status ? (String(args.status) as KbDocumentStatus) : undefined,
          layer: args.layer ? (String(args.layer) as KbLayer) : undefined,
          namespace: args.namespace ? String(args.namespace) : undefined,
          q: args.q ? String(args.q) : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        }),
      };
    case "cw_kb_get_document": {
      const document = await requireDocumentKb(runtime).getDocument(String(args.document_id ?? ""));
      if (!document) {
        throw new Error(`Document not found: ${args.document_id}`);
      }
      return { document };
    }
    case "cw_kb_ingest_document": {
      const text = String(args.text ?? "");
      if (!text.trim()) {
        throw new Error("text is required");
      }
      const document = await requireDocumentKb(runtime).ingestDocument({
        text,
        title: args.title ? String(args.title) : undefined,
        source: args.source ? String(args.source) : undefined,
        namespace: args.namespace ? String(args.namespace) : undefined,
        layer: args.layer ? (String(args.layer) as KbLayer) : undefined,
        doc_type: args.doc_type ? String(args.doc_type) : undefined,
        auto_publish: args.auto_publish === true,
      });
      return { document };
    }
    case "cw_kb_publish":
      return {
        document: await requireDocumentKb(runtime).publishDocument(String(args.document_id ?? "")),
      };
    case "cw_kb_lint_document":
      return requireDocumentKb(runtime).lintDocument(String(args.document_id ?? ""));
    case "cw_kb_create_ingest_job":
      return {
        job: requireDocumentKb(runtime).createIngestJob({
          folder_path: args.folder_path ? String(args.folder_path) : undefined,
          source_path: args.source_path ? String(args.source_path) : undefined,
          text: args.text ? String(args.text) : undefined,
          title: args.title ? String(args.title) : undefined,
          source: args.source ? String(args.source) : undefined,
          namespace: args.namespace ? String(args.namespace) : undefined,
          layer: args.layer ? (String(args.layer) as KbLayer) : undefined,
          doc_type: args.doc_type ? String(args.doc_type) : undefined,
          auto_publish: args.auto_publish === true,
        }),
      };
    case "cw_kb_process_ingest_job":
      return {
        job: await requireDocumentKb(runtime).processIngestJob(String(args.job_id ?? "")),
      };
    case "cw_kb_ingest": {
      const text = String(args.text ?? "");
      await runtime.kb.ingest(text, {
        namespace: args.namespace ? String(args.namespace) : undefined,
        source: args.source ? String(args.source) : undefined,
      });
      return { ingested: true };
    }
    case "cw_kb_flush": {
      if (typeof runtime.kb.flush !== "function") {
        return { flushed: false, note: "KB provider has no flush hook" };
      }
      await runtime.kb.flush();
      return { flushed: true };
    }
    case "cw_kb_ingest_folder":
      return ingestKbFolder(runtime.kb, {
        folder_path: String(args.folder_path ?? ""),
        namespace: args.namespace ? String(args.namespace) : undefined,
        recursive: args.recursive !== false,
        source_prefix: args.source_prefix ? String(args.source_prefix) : undefined,
      });
    case "cw_agent_chat": {
      if (!runtime.llmComplete) {
        throw new Error("LLM not configured on this robot");
      }
      const messages = (args.messages ?? []) as Array<{ role?: string; content?: string }>;
      const lastUser = [...messages]
        .toReversed()
        .find((m) => m.role === "user")
        ?.content?.trim();
      if (!lastUser) {
        throw new Error("messages must include at least one user message");
      }
      const result = await runtime.llmComplete({
        prompt: lastUser,
        model: args.model ? String(args.model) : undefined,
      });
      return { message: { role: "assistant", content: result.text } };
    }
    case "cw_query_objects": {
      const { items } = await runtime.objectStore.query(String(args.type_name ?? "WorkOrder"), {
        limit: typeof args.limit === "number" ? args.limit : 20,
      });
      return { items };
    }
    case "cw_list_playbooks":
      return {
        playbooks: runtime.playbookEngine.list().map((p) => ({
          id: p.id,
          name: p.name,
          pack: p.pack,
          priority: p.priority,
        })),
      };
    case "cw_health": {
      const { buildHealthPayload } = await import("../../claworks/health.js");
      return buildHealthPayload(runtime);
    }
    case "cw_get_identity": {
      if (args.include_agent_md === true) {
        return {
          ...runtime.identity,
          robot: runtime.robot,
          agent_md: runtime.identity.agentMd,
        };
      }
      return {
        name: runtime.identity.name,
        role: runtime.identity.role,
        domain: runtime.identity.domain,
        rules: runtime.identity.rules,
        owner: runtime.identity.owner,
        robot: runtime.robot,
      };
    }
    case "cw_bridge_im_message": {
      return bridgeImMessage(runtime, {
        channel: String(args.channel ?? "mcp"),
        messageId: String(args.message_id ?? `mcp-${Date.now()}`),
        userId: String(args.user_id ?? "mcp:user"),
        text: String(args.text ?? ""),
        groupId: args.group_id ? String(args.group_id) : undefined,
        extra: args.extra as Record<string, unknown> | undefined,
      });
    }
    case "cw_list_runs": {
      const runs = await runtime.playbookEngine.listRuns({
        playbookId: args.playbook_id ? String(args.playbook_id) : undefined,
        status: args.status ? String(args.status) : undefined,
        limit: typeof args.limit === "number" ? args.limit : 50,
      });
      return { runs };
    }
    case "cw_get_run": {
      const run = await runtime.playbookEngine.getRun(String(args.run_id ?? ""));
      if (!run) {
        throw new Error(`Run not found: ${args.run_id}`);
      }
      return run;
    }
    case "cw_submit_hitl": {
      const run = await runtime.playbookEngine.submitHitlDecision(
        String(args.run_id ?? ""),
        String(args.step_id ?? ""),
        String(args.decision ?? ""),
        args.comment ? String(args.comment) : undefined,
      );
      return { run_id: run.id, status: run.status };
    }
    case "list_pending_hitl": {
      const runs = await runtime.playbookEngine.listRuns({ status: "waiting_hitl", limit: 50 });
      return {
        pending: runs.map((run) => ({
          run_id: run.id,
          playbook_id: run.playbookId,
          waiting_step_id: run.steps.find((s) => s.status === "waiting")?.stepId ?? null,
        })),
      };
    }
    case "get_alarm_summary":
      return buildAlarmSummary(runtime, args.station_id ? String(args.station_id) : undefined);
    case "list_object_types":
    case "cw_list_types":
      return {
        types: runtime.ontology.listTypes().map((t) => ({ name: t.name, pack: t.pack })),
      };
    case "search_kb": {
      const results = await runtime.kb.search(String(args.query ?? ""), {
        limit: typeof args.limit === "number" ? args.limit : 5,
      });
      return { results };
    }
    case "query_objects": {
      const filter =
        args.filters && typeof args.filters === "object" && !Array.isArray(args.filters)
          ? (args.filters as Record<string, unknown>)
          : undefined;
      const { items } = await runtime.objectStore.query(String(args.type_name ?? "WorkOrder"), {
        limit: typeof args.limit === "number" ? args.limit : 20,
        filter,
      });
      return { items };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
