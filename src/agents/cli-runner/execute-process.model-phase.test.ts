import { afterAll, expect, it, vi } from "vitest";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import {
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { runPreparedCliAgent as runPreparedCliAgentCore } from "../cli-runner.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";
import { buildPreparedContext } from "./prepared-context.test-support.js";

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../../tts/tts-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../tts/tts-settings.js")>()),
  buildTtsSystemPromptHintAsync: vi.fn(async () => undefined),
}));

const runPreparedCliAgent = wrapPreparedCliRunWithTestAdmission(runPreparedCliAgentCore);
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cli-model-phase-");
let sessionFileEnvSnapshot: ReturnType<typeof captureEnv> | undefined;

afterAll(() => {
  sessionFileEnvSnapshot?.restore();
  clearRuntimeConfigSnapshot();
});

it("publishes the CLI-observed serving model as a lifecycle model phase", async () => {
  const runId = "run-cli-model-phase";
  const lifecycleEvents: Array<Record<string, unknown>> = [];
  const dispose = onAgentEvent((event) => {
    if (event.runId === runId && event.stream === "lifecycle") {
      lifecycleEvents.push(event.data);
    }
  });
  registerAgentRunContext(runId, {
    sessionKey: "agent:main:cli-model-phase",
    agentId: "main",
  });
  const stdout = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "cli-model-session",
      tools: ["Read"],
      model: "claude-opus-5-5-20261101",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-1",
        model: "claude-opus-5-5-20261101",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        id: "msg-2",
        model: "claude-opus-5-5-20261101",
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
    }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }),
  ].join("\n");
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({ ...createSuccessfulProcessExit(), stdout }),
  );
  sessionFileEnvSnapshot ??= captureEnv(["OPENCLAW_STATE_DIR"]);
  setTestEnvValue("OPENCLAW_STATE_DIR", sessionDirs.make());
  setRuntimeConfigSnapshot({});
  const context = buildPreparedContext({ provider: "claude-cli", model: "opus", runId });
  Object.assign(context.preparedBackend.backend, {
    output: "jsonl",
    input: "stdin",
    jsonlDialect: "claude-stream-json",
  });
  try {
    const result = await runPreparedCliAgent(context);
    expect(result.payloads).toEqual([{ text: "done" }]);
    expect(lifecycleEvents.filter((event) => event.phase === "model")).toEqual([
      { phase: "model", provider: "claude-cli", model: "claude-opus-5-5-20261101" },
    ]);
    expect(getAgentRunContext(runId)?.activeModel).toEqual({
      provider: "claude-cli",
      model: "claude-opus-5-5-20261101",
    });
  } finally {
    dispose();
    clearAgentRunContext(runId);
  }
});
