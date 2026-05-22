import fs from "node:fs";
import { describe, expect, it } from "vitest";

type PluginManifest = {
  id?: string;
  skills?: string[];
  toolMetadata?: Record<string, { configSignals?: Array<{ rootPath?: string }> }>;
  contracts?: { tools?: string[] };
};

const TOOL_NAMES = [
  "cw_agent_chat",
  "cw_alarm_summary",
  "cw_bridge_im_message",
  "cw_create_object",
  "cw_define_object_type",
  "cw_delete_object",
  "cw_doctor_run",
  "cw_evolution_export",
  "cw_evolution_import",
  "cw_evolution_status",
  "cw_get_identity",
  "cw_get_object",
  "cw_hitl_approve",
  "cw_hitl_pending",
  "cw_hitl_reject",
  "cw_import_objects",
  "cw_instances",
  "cw_install_pack",
  "cw_invoke_connector",
  "cw_kb_ingest",
  "cw_kb_create_ingest_job",
  "cw_kb_flush",
  "cw_kb_get_document",
  "cw_kb_ingest_document",
  "cw_kb_ingest_folder",
  "cw_kb_lint_document",
  "cw_kb_list_documents",
  "cw_kb_process_ingest_job",
  "cw_kb_publish",
  "cw_kb_search",
  "cw_kb_status",
  "cw_list_connectors",
  "cw_list_events",
  "cw_list_packs",
  "cw_list_playbooks",
  "cw_list_types",
  "cw_playbook_runs",
  "cw_playbooks_list",
  "cw_publish_event",
  "cw_query_objects",
  "cw_reload_packs",
  "cw_reload_playbooks",
  "cw_send_message",
  "cw_status",
  "cw_trigger_playbook",
  "cw_update_config",
  "cw_update_object",
  "cw_write_playbook",
] as const;

const CONFIG_ROOT = "plugins.entries.claworks-robot.config";

describe("claworks-robot plugin manifest contract", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as PluginManifest;
  const indexSource = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const toolsSource = fs.readFileSync(new URL("./cw-tools.ts", import.meta.url), "utf8");
  const opsSource = fs.readFileSync(new URL("./cw-tools-ops.ts", import.meta.url), "utf8");
  const sharedSource = fs.readFileSync(new URL("./cw-tools-shared.ts", import.meta.url), "utf8");
  const combinedTools = `${toolsSource}\n${opsSource}\n${sharedSource}`;

  it("declares contracted tools in manifest", () => {
    expect(manifest.contracts?.tools?.sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("registers every contracted tool in cw-tools.ts / cw-tools-ops.ts", () => {
    for (const tool of TOOL_NAMES) {
      expect(combinedTools).toContain(`name: "${tool}"`);
    }
    expect(combinedTools).toContain("{ name: def.name }");
    expect(combinedTools).toContain('{ name: "cw_agent_chat" }');
  });

  it("uses cw_ prefix for all contracted tools", () => {
    for (const tool of manifest.contracts?.tools ?? []) {
      expect(tool.startsWith("cw_")).toBe(true);
    }
  });

  it("declares skills directory", () => {
    expect(manifest.skills).toEqual(["./skills"]);
  });

  it("maps toolMetadata configSignals to claworks-robot config root", () => {
    for (const tool of TOOL_NAMES) {
      const meta = manifest.toolMetadata?.[tool];
      expect(meta?.configSignals?.[0]?.rootPath).toBe(CONFIG_ROOT);
    }
  });

  it("guards full registration mode", () => {
    expect(indexSource).toContain('api.registrationMode !== "full"');
  });

  it("uses plugin-sdk jsonResult for tool returns", () => {
    expect(combinedTools).toContain("jsonResult");
    expect(combinedTools).toContain("openclaw/plugin-sdk/core");
  });
});
