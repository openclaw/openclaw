import { describe, expect, it } from "vitest";
import type { AnyAgentTool, OpenClawPluginApi } from "../../../src/plugins/types.js";
import register from "../index.js";

function createFakeApi() {
  const tools: AnyAgentTool[] = [];
  const api = {
    id: "sophon",
    name: "sophon",
    source: "test",
    config: {},
    pluginConfig: {},
    runtime: { version: "test" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool(tool: AnyAgentTool) {
      tools.push(tool);
    },
  } as unknown as OpenClawPluginApi;

  return { api, tools };
}

describe("sophon plugin", () => {
  it("registers all expected tools", () => {
    const { api, tools } = createFakeApi();
    register(api);

    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "sophon_archive_note",
      "sophon_archive_project",
      "sophon_archive_task",
      "sophon_complete_task",
      "sophon_create_note",
      "sophon_create_project",
      "sophon_create_task",
      "sophon_dashboard",
      "sophon_get_note",
      "sophon_get_project",
      "sophon_get_task",
      "sophon_list_notes",
      "sophon_list_projects",
      "sophon_list_tasks",
      "sophon_search",
      "sophon_update_note",
      "sophon_update_project",
      "sophon_update_task",
    ]);
  });
});
