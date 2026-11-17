import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "../cli-output-stream-limits.js";
import { runPreparedCliAgent as runPreparedCliAgentImpl } from "../cli-runner.js";
import * as cliTranscript from "../command/attempt-execution.helpers.js";
import { hasModelFallbackStop } from "../failover-error.js";
import { buildContext } from "./execute-events.tool-result-args.test-support.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";
import type { PreparedCliRunContext } from "./types.js";

const runPreparedCliAgent = wrapPreparedCliRunWithTestAdmission(runPreparedCliAgentImpl);

// mock-isolation: The supervisor fixture owns execution; never spawn host CLI processes.
vi.mock("../../process/supervisor/adapters/child.js", () => ({
  createChildAdapter: vi.fn(),
}));

type SupervisorSpawnInput = Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];

const { maxPendingLineChars, maxTurnRawChars } = CLI_STREAM_JSON_OUTPUT_LIMITS;

function buildClaudeStreamJsonRunContext(runId: string): PreparedCliRunContext {
  const context = buildContext(runId);
  Object.assign(context.preparedBackend.backend, {
    serialize: false,
    jsonlDialect: "claude-stream-json",
  });
  context.params.timeoutMs = 60_000;
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

describe("CLI stream-json output limit", () => {
  it.each(["before", "after"] as const)(
    "stops a supervised CLI when the line limit trips %s spawn settles",
    async (when) => {
      const waiting = createDeferred();
      const exited = createDeferred();
      const cancelledExit = {
        ...createSuccessfulProcessExit(),
        reason: "manual-cancel" as const,
        exitCode: null,
        exitSignal: "SIGKILL" as const,
      };
      const managedRun = createManagedRun(cancelledExit);
      managedRun.wait.mockImplementation(async () => {
        waiting.resolve();
        await exited.promise;
        return cancelledExit;
      });
      managedRun.cancel.mockImplementation(() => exited.resolve());
      let spawnInput: SupervisorSpawnInput | undefined;
      const oversizedLine = "x".repeat(maxPendingLineChars + 1);
      supervisorSpawnMock.mockImplementationOnce(async (input) => {
        spawnInput = input;
        if (when === "before") {
          spawnInput.onStdout?.(oversizedLine);
        }
        return managedRun;
      });

      const run = runPreparedCliAgent(buildClaudeStreamJsonRunContext(`run-limit-${when}`));
      if (when === "after") {
        await waiting.promise;
        spawnInput?.onStdout?.(oversizedLine);
      }

      const failure = expect(run).rejects.toMatchObject({
        name: "FailoverError",
        reason: "format",
        message: `CLI JSONL line exceeded ${maxPendingLineChars} characters; refusing to parse output.`,
      });
      await waiting.promise;
      try {
        expect(managedRun.cancel).toHaveBeenCalledWith("manual-cancel");
      } finally {
        // Let the baseline finish too; a missing cancel must fail without hanging.
        exited.resolve();
        await failure;
      }
    },
  );

  it("ends a plugin-owned turn at the output limit and keeps its first-turn native session", async () => {
    const context = buildClaudeStreamJsonRunContext("run-limit-plugin");
    context.params.persistStoppedFirstCliSession = vi.fn();
    vi.spyOn(cliTranscript, "claudeCliSessionTranscriptHasContent").mockResolvedValue(true);
    const record = { type: "system", subtype: "fixture_padding", padding: "x".repeat(1024 * 1024) };
    const recordChars = JSON.stringify(record).length + 1;
    let yielded = 0;
    let closed = false;
    let aborted = false;
    // Plugin transports still resolve the backend executable; keep that off the host PATH.
    context.preparedBackend.backend.command = process.execPath;
    context.executionTarget = {
      kind: "plugin",
      async *execute(execution) {
        execution.abortSignal?.addEventListener("abort", () => {
          aborted = true;
        });
        try {
          yield { type: "system", subtype: "init", session_id: "native-first-turn" };
          // The baseline keeps pulling these records after the turn is already lost.
          while (yielded < 12) {
            yielded += 1;
            yield record;
          }
          yield { type: "result", subtype: "success", is_error: false, result: "done" };
        } finally {
          closed = true;
        }
      },
    };

    const failure = await runPreparedCliAgent(context).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "FailoverError",
      reason: "format",
      message: `CLI JSONL output exceeded ${maxTurnRawChars} characters; refusing to parse output.`,
    });
    // No tool ran, so model fallback may replay the prompt.
    expect(hasModelFallbackStop(failure)).toBe(false);
    // The fallback retry resumes this refused first turn's native session.
    expect(context.params.persistStoppedFirstCliSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "native-first-turn" }),
    );
    // The record that crosses the budget is the last one pulled from the CLI.
    expect(yielded).toBe(Math.floor(maxTurnRawChars / recordChars) + 1);
    expect(aborted).toBe(true);
    expect(closed).toBe(true);
  });

  it("stops model fallback when a turn that already ran a tool exceeds the output limit", async () => {
    const context = buildClaudeStreamJsonRunContext("run-limit-after-tool");
    const padding = {
      type: "system",
      subtype: "fixture_padding",
      padding: "x".repeat(1024 * 1024),
    };
    context.preparedBackend.backend.command = process.execPath;
    context.executionTarget = {
      kind: "plugin",
      async *execute() {
        yield { type: "system", subtype: "init", session_id: "native-tool-turn" };
        yield {
          type: "assistant",
          message: {
            id: "msg-tool",
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu-1", name: "exec", input: { command: "true" } },
            ],
          },
        };
        yield {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "ok" }],
          },
        };
        for (let i = 0; i < 12; i += 1) {
          yield padding;
        }
        yield { type: "result", subtype: "success", is_error: false, result: "done" };
      },
    };

    const failure = await runPreparedCliAgent(context).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "FailoverError",
      message: `CLI JSONL output exceeded ${maxTurnRawChars} characters; refusing to parse output.`,
    });
    // Another model replaying the prompt would run the completed tool again (#200744).
    expect(hasModelFallbackStop(failure)).toBe(true);
  });
});
