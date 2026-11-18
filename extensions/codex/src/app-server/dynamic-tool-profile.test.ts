import { expect, it, vi } from "vitest";
import {
  filterCodexDynamicTools,
  resolveCodexDynamicToolsLoading,
} from "./dynamic-tool-profile.js";

const names = (value: string) => value.split(" ");
const goals = "progress_card get_goal create_goal update_goal";
const shell = `read write edit apply_patch exec process ${goals} message`;

it.each([
  {
    name: "native-owned tools",
    input: `read write edit apply_patch exec process update_plan ${goals} dispatch_action tool_describe tool_search web_search message heartbeat_respond sessions_spawn`,
    expected: `${goals} web_search message heartbeat_respond sessions_spawn`,
  },
  {
    name: "disabled native tools with shell replacements",
    input: shell,
    expected: shell,
    preserveShell: true,
  },
  {
    name: "disabled native tools with explicit exclusions",
    input: shell,
    expected: `read edit ${goals} message`,
    excludes: ["write", "apply_patch"],
    preserveShell: false,
  },
  {
    name: "additional plugin exclusions",
    input: "read exec message custom_tool get_goal update_goal",
    expected: "message get_goal",
    excludes: ["custom_tool", "update_goal"],
  },
  {
    name: "private QA native replacements",
    input: "read write apply_patch apply-patch get_goal image_generate message",
    expected: "read write get_goal image_generate message",
    privateQa: true,
  },
])("filters $name from the dynamic tool profile", (testCase) => {
  const tools = names(testCase.input).map((name) => ({ name }));
  const config = { codexDynamicToolsExclude: testCase.excludes };
  vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", testCase.privateQa ? "1" : undefined);
  vi.stubEnv("OPENCLAW_QA_FORCE_RUNTIME", testCase.privateQa ? "codex" : undefined);
  const filtered = filterCodexDynamicTools(tools, config, {
    disabledNativeSurface:
      testCase.preserveShell === undefined ? undefined : { preserveShell: testCase.preserveShell },
  });
  expect(filtered.map((tool) => tool.name)).toEqual(names(testCase.expected));
  if (testCase.privateQa) {
    expect(resolveCodexDynamicToolsLoading({})).toBe("direct");
  }
});
