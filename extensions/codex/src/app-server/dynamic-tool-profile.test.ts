import { describe, expect, it } from "vitest";
import {
  filterCodexDynamicTools,
  resolveCodexDynamicToolsLoading,
} from "./dynamic-tool-profile.js";

describe("Codex dynamic tool profile", () => {
  it.each<{
    name: string;
    input: string[];
    expected: string[];
    excludes?: string[];
    preserveShell?: boolean;
    privateQa?: boolean;
  }>([
    {
      name: "native-owned tools",
      input: [
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "update_plan",
        "progress_card",
        "get_goal",
        "create_goal",
        "update_goal",
        "dispatch_action",
        "tool_describe",
        "tool_search",
        "web_search",
        "message",
        "heartbeat_respond",
        "sessions_spawn",
      ],
      expected: [
        "progress_card",
        "get_goal",
        "create_goal",
        "update_goal",
        "web_search",
        "message",
        "heartbeat_respond",
        "sessions_spawn",
      ],
    },
    {
      name: "disabled native tools with shell replacements",
      input: [
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "progress_card",
        "get_goal",
        "create_goal",
        "update_goal",
        "message",
      ],
      expected: [
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "progress_card",
        "get_goal",
        "create_goal",
        "update_goal",
        "message",
      ],
      preserveShell: true,
    },
    {
      name: "disabled native tools with explicit exclusions",
      input: [
        "read",
        "write",
        "edit",
        "apply_patch",
        "exec",
        "process",
        "progress_card",
        "get_goal",
        "create_goal",
        "update_goal",
        "message",
      ],
      expected: [
        "read",
        "edit",
        "progress_card",
        "get_goal",
        "create_goal",
        "update_goal",
        "message",
      ],
      excludes: ["write", "apply_patch"],
      preserveShell: false,
    },
    {
      name: "additional plugin exclusions",
      input: ["read", "exec", "message", "custom_tool", "get_goal", "update_goal"],
      expected: ["message", "get_goal"],
      excludes: ["custom_tool", "update_goal"],
    },
    {
      name: "private QA native replacements",
      input: [
        "read",
        "write",
        "apply_patch",
        "apply-patch",
        "get_goal",
        "image_generate",
        "message",
      ],
      expected: ["read", "write", "get_goal", "image_generate", "message"],
      privateQa: true,
    },
  ])("filters $name from the dynamic tool profile", (testCase) => {
    const tools = testCase.input.map((name) => ({ name }));
    const config = { codexDynamicToolsExclude: testCase.excludes };
    const env = testCase.privateQa
      ? { OPENCLAW_BUILD_PRIVATE_QA: "1", OPENCLAW_QA_FORCE_RUNTIME: "codex" }
      : undefined;
    const filtered = filterCodexDynamicTools(tools, config, {
      env,
      disabledNativeSurface:
        testCase.preserveShell === undefined
          ? undefined
          : { preserveShell: testCase.preserveShell },
    });
    expect(filtered.map((tool) => tool.name)).toEqual(testCase.expected);
    if (testCase.privateQa) {
      expect(resolveCodexDynamicToolsLoading({}, env)).toBe("direct");
    }
  });
});
