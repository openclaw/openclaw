import { bridgeImMessage } from "../../claworks/im-bridge.js";
import { applyIngressPublish } from "../../claworks/ingress-publish.js";
import { reloadClaworksPacksFromDisk } from "../../claworks/pack-runtime.js";
import type { ClaworksRuntime } from "../../claworks/runtime.js";

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
    name: "cw_kb_search",
    description: "Search the knowledge base",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
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
];

export async function callClaworksMcpTool(
  runtime: ClaworksRuntime,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
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
    case "cw_kb_search":
      return {
        results: await runtime.kb.search(String(args.query ?? ""), {
          limit: typeof args.limit === "number" ? args.limit : 5,
        }),
      };
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
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
