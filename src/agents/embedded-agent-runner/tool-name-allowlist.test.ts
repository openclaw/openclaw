import { describe, expect, it } from "vitest";
import { findClientToolNameConflicts } from "../agent-tool-definition-adapter.js";
import { createStubTool } from "../test-helpers/agent-tool-stubs.js";
import { addClientToolsToToolCatalog } from "../tool-search-catalog.js";
import {
  applyToolSearchCatalog,
  createToolSearchCatalogRef,
  TOOL_CALL_RAW_TOOL_NAME,
} from "../tool-search.js";
import type { ClientToolDefinition } from "./run/params.js";
import {
  collectAllowedToolNames,
  collectRegisteredToolNames,
  AGENT_RESERVED_TOOL_NAMES,
  toSessionToolAllowlist,
} from "./tool-name-allowlist.js";

const config = { tools: { toolSearch: true } } as never;
const clientTool = (name: string): ClientToolDefinition => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
});
const clientTools = [clientTool("client_pick_file")];
const toolsNamed = (...names: string[]) => names.map((name) => createStubTool(name));
const compact = (
  tools: ReturnType<typeof createStubTool>[],
  catalogRef = createToolSearchCatalogRef(),
) => applyToolSearchCatalog({ tools, config, catalogRef });
const sessionAllowlist = (
  tools: ReturnType<typeof createStubTool>[],
  clients?: ClientToolDefinition[],
) => toSessionToolAllowlist(collectAllowedToolNames({ tools, clientTools: clients }));

describe("tool name allowlists", () => {
  it("collects exact registered custom-tool names for the agent session allowlist", () => {
    const allowlist = toSessionToolAllowlist(
      collectRegisteredToolNames([
        { name: "exec" },
        { name: "read" },
        { name: "exec" },
        { name: "image_generate" },
      ]),
    );

    expect(allowlist).toEqual(["exec", "image_generate", "read"]);
  });

  it("keeps hidden core names available for client conflict admission", () => {
    const uncompactedTools = toolsNamed(TOOL_CALL_RAW_TOOL_NAME, "exec", "message");
    const compacted = compact(uncompactedTools);
    const names = collectRegisteredToolNames(uncompactedTools);

    expect([...names]).toEqual([TOOL_CALL_RAW_TOOL_NAME, "exec", "message"]);
    expect(compacted.tools.map((tool) => tool.name)).toEqual([TOOL_CALL_RAW_TOOL_NAME, "exec"]);
    expect(
      findClientToolNameConflicts({
        tools: [clientTool("exec")],
        existingToolNames: [...names, ...AGENT_RESERVED_TOOL_NAMES],
      }),
    ).toEqual(["exec"]);
  });

  it("pins the reserved OpenClaw built-in tool namespace used by client conflict checks", () => {
    expect(AGENT_RESERVED_TOOL_NAMES).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  });

  it("keeps collected run allowlists broader than the agent session allowlist source", () => {
    const allowlist = toSessionToolAllowlist(
      collectAllowedToolNames({
        tools: [createStubTool("exec"), createStubTool("read"), createStubTool("exec")],
        clientTools: [
          {
            type: "function",
            function: {
              name: "image_generate",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      }),
    );

    expect(allowlist).toEqual(["exec", "image_generate", "read"]);
  });

  it("excludes client tool names when Tool Search compacts them into the catalog", () => {
    const catalogRef = createToolSearchCatalogRef();
    const compacted = compact(toolsNamed(TOOL_CALL_RAW_TOOL_NAME), catalogRef);
    const clientToolSearch = addClientToolsToToolCatalog({
      tools: toolsNamed("client_pick_file"),
      enabled: true,
      catalogRef,
    });

    expect(compacted.catalogRegistered).toBe(true);
    expect(clientToolSearch.tools).toEqual([]);
    expect(
      sessionAllowlist(compacted.tools, compacted.catalogRegistered ? undefined : clientTools),
    ).toEqual([TOOL_CALL_RAW_TOOL_NAME]);
  });

  it("keeps hidden catalog tools valid for replay guards after Tool Search compaction", () => {
    const uncompactedTools = toolsNamed(TOOL_CALL_RAW_TOOL_NAME, "exec", "fake_plugin_tool");
    const compacted = compact(uncompactedTools);
    expect(
      sessionAllowlist(compacted.tools, compacted.catalogRegistered ? undefined : clientTools),
    ).toEqual([TOOL_CALL_RAW_TOOL_NAME, "exec"]);
    expect(sessionAllowlist(uncompactedTools, clientTools)).toEqual([
      "client_pick_file",
      TOOL_CALL_RAW_TOOL_NAME,
      "exec",
      "fake_plugin_tool",
    ]);
  });
});
