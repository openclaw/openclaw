import fs from "node:fs/promises";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

afterEach(() => vi.restoreAllMocks());

it("keeps Codex apply_patch containment diagnostics operator-only", async () => {
  await withOpenClawTestState({ layout: "split", prefix: "codex-patch-hint-" }, async (state) => {
    const root = state.workspaceDir;
    const outside = state.path("outside.txt");
    await fs.writeFile(outside, "original\n");
    const tools = createOpenClawCodingTools({
      workspaceDir: root,
      config: {},
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: true,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: false,
      },
    }).filter((tool) => tool.name === "apply_patch");
    expect(tools).toHaveLength(1);
    const logError = vi.spyOn(embeddedAgentLog, "error").mockImplementation(() => {});
    const onAgentToolResult = vi.fn();
    const bridge = createCodexDynamicToolBridge({
      tools,
      signal: new AbortController().signal,
    });
    const call = {
      threadId: "thread-patch-hint",
      turnId: "turn-patch-hint",
      callId: "outside-patch",
      namespace: null,
      tool: "apply_patch",
      arguments: {
        input: `*** Begin Patch\n*** Update File: ${outside}\n@@\n-original\n+changed\n*** End Patch`,
      },
    };
    const response = await bridge.handleToolCall(call, { onAgentToolResult });
    const hint = "workspace-contained by configuration";
    const message = `Path escapes sandbox root (${root}): ${outside}`;
    expect(logError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(hint));
    expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
      contentItems: [{ type: "inputText", text: message }],
      success: false,
    });
    expect(onAgentToolResult).toHaveBeenCalledExactlyOnceWith({
      toolName: "apply_patch",
      result: expect.objectContaining({
        content: [{ type: "text", text: message }],
      }),
      isError: true,
    });
    expect(JSON.stringify(onAgentToolResult.mock.calls)).not.toContain(hint);
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("original\n");
  });
});
