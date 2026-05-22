import type { IncomingMessage } from "node:http";
import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { checkRbac, resolveAuthContext, type AuthContext } from "../rest/auth.js";

const MCP_READ_TOOLS = new Set([
  "cw_kb_status",
  "cw_kb_search",
  "cw_kb_list_documents",
  "cw_kb_get_document",
  "cw_kb_lint_document",
  "cw_query_objects",
  "cw_list_playbooks",
  "cw_health",
  "cw_get_identity",
  "cw_list_runs",
  "cw_get_run",
  "list_pending_hitl",
  "get_alarm_summary",
  "list_object_types",
  "search_kb",
  "query_objects",
]);

export function resolveMcpAuth(req: IncomingMessage, runtime: ClaworksRuntime): AuthContext {
  return resolveAuthContext(req, runtime);
}

export function mcpToolWriteResource(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "cw_trigger_playbook":
      return `playbook:${String(args.playbook_id ?? "*")}`;
    case "cw_publish_event":
      return String(args.event_type ?? args.type ?? "*");
    case "cw_reload_packs":
      return "pack:*";
    case "cw_kb_ingest":
      return "kb:ingest";
    case "cw_kb_flush":
      return "kb:flush";
    case "cw_kb_ingest_folder":
      return "kb:ingest:folder";
    case "cw_kb_ingest_document":
    case "cw_kb_create_ingest_job":
    case "cw_kb_process_ingest_job":
      return "kb:ingest";
    case "cw_kb_publish":
      return "kb:publish";
    case "cw_agent_chat":
      return "agent:chat";
    case "cw_bridge_im_message":
      return "playbook:classify_im_to_business_event";
    case "cw_submit_hitl":
      return `hitl:${String(args.run_id ?? "*")}`;
    case "ingest_kb_text":
      return "kb:ingest";
    default:
      return `mcp:${toolName}`;
  }
}

export function checkMcpToolAuth(
  runtime: ClaworksRuntime,
  auth: AuthContext,
  toolName: string,
  args: Record<string, unknown>,
): { allowed: true } | { allowed: false; reason: string } {
  if (MCP_READ_TOOLS.has(toolName)) {
    return { allowed: true };
  }
  const resource = mcpToolWriteResource(toolName, args);
  const action =
    toolName === "cw_bridge_im_message"
      ? "playbook.trigger"
      : toolName === "cw_publish_event"
        ? "event.publish"
        : toolName === "cw_trigger_playbook"
          ? "playbook.trigger"
          : "rest.write";
  return checkRbac(runtime, auth, action, resource);
}

export async function publishMcpRbacDenied(
  runtime: ClaworksRuntime,
  auth: AuthContext,
  toolName: string,
  reason: string,
): Promise<void> {
  const resource = mcpToolWriteResource(toolName, {});
  await runtime.kernel
    .publish(
      "rbac.denied",
      "mcp",
      {
        subject_type: auth.subjectType,
        subject_id: auth.subjectId,
        action: "rest.write",
        resource,
        tool: toolName,
        reason,
      },
      { subjectType: "system", subjectId: "rbac" },
    )
    .catch(() => undefined);
}
