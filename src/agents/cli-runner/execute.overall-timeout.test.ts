import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { runPreparedCliAgent as runPreparedCliAgentImpl } from "../cli-runner.js";
import { hasModelFallbackStop } from "../failover-error.js";
import { buildContext } from "./execute-events.tool-result-args.test-support.js";
import { waitUntilAborted } from "./execute-plugin.test-support.js";
import {
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";
import type { PreparedCliRunContext } from "./types.js";

const runPreparedCliAgent = wrapPreparedCliRunWithTestAdmission(runPreparedCliAgentImpl);

// mock-isolation: The supervisor fixture owns execution; never spawn host CLI processes.
vi.mock("../../process/supervisor/adapters/child.js", () => ({
  createChildAdapter: vi.fn(),
}));

// The run deadline the watchdog enforces for these fixtures; small enough to keep the
// regression fast, far below the deferred no-output watchdog of an outstanding tool.
const RUN_TIMEOUT_MS = 600;

function buildClaudeStreamJsonRunContext(runId: string): PreparedCliRunContext {
  const context = buildContext(runId);
  Object.assign(context.preparedBackend.backend, {
    serialize: false,
    jsonlDialect: "claude-stream-json",
  });
  context.params.timeoutMs = RUN_TIMEOUT_MS;
  return context;
}

beforeEach(() => {
  resetAgentEventsForTest();
  resetDiagnosticEventsForTest();
  supervisorSpawnMock.mockReset();
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: "fixture-cli-provider",
    provider: {
      id: "fixture-cli-provider",
      label: "Fixture CLI provider",
      hookAliases: ["claude-cli"],
      auth: [],
    },
    source: "test",
  });
  setActivePluginRegistry(registry);
});

describe("CLI run timeout fallback stop", () => {
  it("stops model fallback when a turn that already started a tool exceeds the run timeout", async () => {
    const context = buildClaudeStreamJsonRunContext("run-timeout-after-tool");
    const tool = { type: "tool_use", id: "toolu-1", name: "exec", input: { command: "sleep 240" } };
    // Plugin transports still resolve the backend executable; keep that off the host PATH.
    context.preparedBackend.backend.command = process.execPath;
    context.executionTarget = {
      kind: "plugin",
      async *execute(execution) {
        yield { type: "assistant", message: { id: "msg-1", role: "assistant", content: [tool] } };
        // The tool never completes; the run deadline expires while it is outstanding.
        await waitUntilAborted(execution);
      },
    };

    const failure = await runPreparedCliAgent(context).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "FailoverError",
      code: "cli_overall_timeout",
      cliTimeout: {
        mode: "overall",
        activeToolCount: 1,
      },
    });
    // Another model replaying the prompt would restart the still-running task (#203465).
    expect(hasModelFallbackStop(failure)).toBe(true);
  });

  it("keeps a run timeout before any tool work eligible for model fallback", async () => {
    const context = buildClaudeStreamJsonRunContext("run-timeout-before-tool");
    context.preparedBackend.backend.command = process.execPath;
    context.executionTarget = {
      kind: "plugin",
      async *execute(execution) {
        yield { type: "system", subtype: "init", session_id: "native-idle-turn" };
        // No tool or assistant work: the run deadline expires on an idle turn.
        await waitUntilAborted(execution);
      },
    };

    const failure = await runPreparedCliAgent(context).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "FailoverError",
      code: "cli_overall_timeout",
    });
    // No tool effects ran, so the timeout stays failover-eligible (#186915).
    expect(hasModelFallbackStop(failure)).toBe(false);
  });
});
