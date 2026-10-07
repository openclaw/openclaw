import "./dynamic-tool-build.test-support.js";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";

const { buildDynamicToolsForTest, createCodexRuntimePlanFixture, createParams, hoisted } =
  await import("./dynamic-tool-build.test-support.js");

type RuntimeDynamicToolForTest = Parameters<
  typeof createCodexDynamicToolBridge
>[0]["tools"][number];

const RUNNING_RESULT_GUIDANCE =
  "Running means the process was started and was alive when this result was written; it says nothing about progress, waiting for input, or a later exit or failure. Do not report progress from this result alone. Completion will wake this conversation automatically. The completion turn may not be allowed to message the user, so if only waiting remains, report that the job is running without promising to report back and end this turn; do not keep polling.";

function createRuntimeDynamicTool(name: string): RuntimeDynamicToolForTest {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: `${name} done` }],
      details: {},
    })),
  };
}

describe("Codex app-server dynamic tool background follow-up", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let tempDir: string;

  beforeEach(() => {
    hoisted.loadNodeExecAvailability.mockResolvedValue({
      cacheKey: "eligible",
      isAvailable: () => true,
    });
    tempDir = tempDirs.make("openclaw-codex-followup-");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps the running caution while rewriting sandbox process follow-up", async () => {
    // The sandbox alias rewrites only the trailing follow-up sentence by exact
    // literal, so the shared caution before it must survive unchanged.
    const execTool = createRuntimeDynamicTool("exec");
    vi.mocked(execTool.execute).mockResolvedValueOnce({
      content: [
        {
          type: "text",
          text: `Command still running (session exec-1, pid 123). ${RUNNING_RESULT_GUIDANCE} Use process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.`,
        },
      ],
      details: { status: "running" },
    });
    const workspaceDir = path.join(tempDir, "workspace");
    const params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir);
    setCodexTestToolFactory(params, () => [
      execTool,
      createRuntimeDynamicTool("process"),
      createRuntimeDynamicTool("message"),
    ]);
    params.disableTools = false;
    params.runtimePlan = createCodexRuntimePlanFixture();

    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: { enabled: true, backendId: "ssh" } as never,
      nativeToolSurfaceEnabled: false,
    });

    const sandboxExec = tools.find((tool) => tool.name === "sandbox_exec");
    const result = await sandboxExec?.execute("call-1", { command: "sleep 1" }, undefined);
    expect(result?.content).toEqual([
      {
        type: "text",
        text: `Command still running (session exec-1, pid 123). ${RUNNING_RESULT_GUIDANCE} Use sandbox_process (list/poll/log/write/send-keys/submit/paste/kill/clear/remove) for follow-up.`,
      },
    ]);
  });
});
