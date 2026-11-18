import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./harness/tool-surface-bridge.js";
import { createOpenClawContinuationTools } from "./openclaw-tools.continuation.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

// Continuation tools must be known the way exec is: direct provider tools with
// ## Tooling slots even when Tool Search (on when tools.toolSearch is unset)
// catalogs everything else. Availability stays with the continuation owner.
const runtimes: ReturnType<typeof createAgentHarnessToolSurfaceRuntimeCore>[] = [];
afterEach(() => runtimes.splice(0).forEach((runtime) => runtime.cleanup()));

function buildSurface(tools: OpenClawConfig["tools"], continuation = true) {
  const { config } = createCanonicalAgentConfigFixture({
    agents: { defaults: { continuation: { enabled: continuation } } },
    ...(tools ? { tools } : {}),
  });
  const requestContinuation = vi.fn();
  const runtime = createAgentHarnessToolSurfaceRuntimeCore({
    config,
    modelToolsEnabled: true,
    executeTool: async () => ({ content: [], details: {} }),
  });
  runtimes.push(runtime);
  const surface = runtime.compactTools([
    ...createOpenClawContinuationTools({
      config,
      agentSessionKey: "agent:main:main",
      continueWorkOpts: { requestContinuation },
    }),
    createSessionsYieldTool({ sessionId: "session-1" }),
    createStubTool("fixture_lookup"),
  ]);
  const names = surface.tools.map((tool) => tool.name);
  const catalog = runtime.toolSearchCatalogRef?.current?.entries.map((entry) => entry.name);
  const tooling = (directory?: string) =>
    buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      continuationEnabled: true,
      toolNames: names,
      toolSchemaDirectoryPrompt: directory,
    })
      .split("Tools policy-filtered. Names case-sensitive; call exact.\n")[1]
      ?.split("The AGENTS.md Tools section guides usage")[0]
      ?.split("### Deferred Tool Schemas");
  return { surface, names, catalog, tooling, requestContinuation };
}

const search = ["tool_search", "tool_describe", "dispatch_action"];
const direct = ["continue_work", "continue_delegate", "sessions_yield"];
const workLine = "- continue_work: Arm your next turn for unfinished work, now or after a delay.";
const delegateLine =
  "- continue_delegate: Queue a bounded branch after this turn or later; `silent-wake` wakes you on return.";

describe("continuation tools beside sessions_yield on cataloged tool surfaces", () => {
  it.each([
    ["Tool Search default (unset)", undefined, search],
    ["Tool Search directory", { codeMode: false, toolSearch: { mode: "directory" } }, search],
    ["Code Mode", { codeMode: true }, ["exec", "wait"]],
  ] as const)("keeps them direct, never deferred: %s", async (_label, tools, controls) => {
    const { surface, names, catalog, tooling, requestContinuation } = buildSurface(tools);
    expect(names).toEqual([...controls, ...direct]);
    expect(catalog).toEqual(["fixture_lookup"]);
    const directory = surface.promptToolPolicy.apply().toolSchemaDirectoryPrompt;
    expect(directory).toContain("fixture_lookup");
    expect(directory).not.toContain("continue_");
    const [list, deferred] = tooling(directory) ?? [];
    expect(list).toContain(`- sessions_yield: End turn; await subagent events\n${workLine}`);
    expect(list).toContain(delegateLine);
    expect(deferred).toContain("fixture_lookup");
    expect(deferred).not.toContain("continue_");
    const dispatch = surface.tools.find((tool) => tool.name === "dispatch_action");
    for (const id of dispatch ? direct : []) {
      await expect(dispatch?.execute("call-1", { id, args: {} })).rejects.toThrow(
        "Call it directly by its declared name",
      );
    }
    expect(requestContinuation).not.toHaveBeenCalled();
  });

  it("stays absent from direct and deferred surfaces when continuation is disabled", () => {
    const { surface, names, catalog, tooling } = buildSurface(undefined, false);
    expect(names).toEqual([...search, "sessions_yield"]);
    expect(catalog).toEqual(["fixture_lookup"]);
    const directory = surface.promptToolPolicy.apply().toolSchemaDirectoryPrompt;
    expect(directory).toContain("fixture_lookup");
    expect(`${directory}${tooling(directory)?.join("")}`).not.toContain("continue_");
  });

  it("lets a turn's tool policy remove one, direct or deferred", async () => {
    const { surface, requestContinuation } = buildSurface(undefined);
    const turn = surface.promptToolPolicy.apply({
      toolsAllow: ["continue_delegate", "sessions_yield", "fixture_lookup"],
    });
    expect(turn.tools.map((tool) => tool.name)).toEqual([
      ...search,
      "continue_delegate",
      "sessions_yield",
    ]);
    expect(turn.callableToolNames).not.toContain("continue_work");
    expect(turn.toolSchemaDirectoryPrompt).not.toContain("continue_");
    const dispatch = surface.tools.find((tool) => tool.name === "dispatch_action");
    await expect(
      dispatch?.execute("call-2", { id: "continue_work", args: { reason: "x" } }),
    ).rejects.toThrow("Use tool_search");
    expect(requestContinuation).not.toHaveBeenCalled();
  });

  it("is unchanged with Tool Search off: all direct, no catalog", () => {
    const { names, catalog, tooling } = buildSurface({ codeMode: false, toolSearch: false });
    expect(names).toEqual([...direct, "fixture_lookup"]);
    expect(catalog).toBeUndefined();
    expect(tooling()?.[0]).toContain(`${workLine}\n${delegateLine}`);
  });
});
