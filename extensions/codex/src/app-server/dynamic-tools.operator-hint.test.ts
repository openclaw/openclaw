import fs from "node:fs/promises";
import path from "node:path";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";

afterEach(() => vi.restoreAllMocks());

describe("Codex apply_patch operator diagnostics", () => {
  it.each([
    {
      name: "configuration defaults",
      configPolicy: "defaults",
      mode: undefined,
      requiredRoot: false,
      hint: "workspace-contained by configuration",
    },
    {
      name: "filesystem configuration alone",
      configPolicy: "filesystem-only",
      mode: undefined,
      requiredRoot: false,
      hint: "workspace-contained by configuration",
    },
    {
      name: "session policy with configuration disabled",
      configPolicy: "disabled",
      mode: "guarded",
      requiredRoot: false,
      hint: "this session's permission mode",
    },
    {
      name: "required root in full mode with configuration disabled",
      configPolicy: "disabled",
      mode: "full",
      requiredRoot: true,
      hint: "this run's required workspace root",
    },
    {
      name: "full mode without a required root",
      configPolicy: "defaults",
      mode: "full",
      requiredRoot: false,
      hint: undefined,
    },
    {
      name: "configuration disabled without a session policy",
      configPolicy: "disabled",
      mode: undefined,
      requiredRoot: false,
      hint: undefined,
    },
  ] as const)("keeps diagnostics operator-only for $name", async (testCase) => {
    await withOpenClawTestState({ layout: "split", prefix: "codex-patch-hint-" }, async (state) => {
      const root = state.workspaceDir;
      const outside = state.path("outside.txt");
      await fs.writeFile(outside, "original\n");
      const tools = createOpenClawCodingTools({
        workspaceDir: root,
        ...(testCase.requiredRoot ? { requireWorkspaceOnly: true } : {}),
        sessionPermissionPolicy: testCase.mode ? { root, mode: testCase.mode } : undefined,
        config:
          testCase.configPolicy === "defaults"
            ? {}
            : {
                tools: {
                  exec: { applyPatch: { workspaceOnly: false } },
                  fs: { workspaceOnly: testCase.configPolicy === "filesystem-only" },
                },
              },
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
      if (testCase.hint) {
        const message = `Path escapes sandbox root (${root}): ${outside}`;
        expect(logError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(testCase.hint));
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
        expect(JSON.stringify(onAgentToolResult.mock.calls)).not.toContain(testCase.hint);
        await expect(fs.readFile(outside, "utf8")).resolves.toBe("original\n");
      } else {
        expect(response.success).toBe(true);
        expect(logError).not.toHaveBeenCalled();
        await expect(fs.readFile(outside, "utf8")).resolves.toBe("changed\n");
      }

      logError.mockClear();
      const inside = await bridge.handleToolCall({
        ...call,
        callId: "inside-patch",
        arguments: { input: "*** Begin Patch\n*** Add File: inside.txt\n+inside\n*** End Patch" },
      });
      expect(inside.success).toBe(true);
      expect(logError).not.toHaveBeenCalled();
      await expect(fs.readFile(path.join(root, "inside.txt"), "utf8")).resolves.toBe("inside\n");
    });
  });
});
