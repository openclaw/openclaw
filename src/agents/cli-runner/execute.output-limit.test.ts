import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "../cli-output-stream-limits.js";
import { buildContext } from "./execute-events.tool-result-args.test-support.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";
import type { PreparedCliRunContext } from "./types.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

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

      const run = executePreparedCliRun(buildClaudeStreamJsonRunContext(`run-limit-${when}`));
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

  it("leaves a supervised CLI running past a spent turn budget and delivers its result", async () => {
    const waiting = createDeferred();
    const exited = createDeferred();
    const exit = createSuccessfulProcessExit();
    const managedRun = createManagedRun(exit);
    managedRun.wait.mockImplementation(async () => {
      waiting.resolve();
      await exited.promise;
      return exit;
    });
    let spawnInput: SupervisorSpawnInput | undefined;
    supervisorSpawnMock.mockImplementationOnce(async (input) => {
      spawnInput = input;
      return managedRun;
    });
    const padding = {
      type: "system",
      subtype: "fixture_padding",
      padding: "x".repeat(1024 * 1024),
    };
    const paddingLine = `${JSON.stringify(padding)}\n`;

    const run = executePreparedCliRun(buildClaudeStreamJsonRunContext("run-budget-supervised"));
    await waiting.promise;
    for (let sent = 0; sent * paddingLine.length <= maxTurnRawChars; sent += 1) {
      spawnInput?.onStdout?.(paddingLine);
    }
    // The budget is spent, but the turn can still finish: the CLI is not killed.
    expect(managedRun.cancel).not.toHaveBeenCalled();
    spawnInput?.onStdout?.(
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" })}\n`,
    );
    exited.resolve();

    await expect(run).resolves.toMatchObject({ text: "done" });
    expect(managedRun.cancel).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "recovers the finished turn", finishes: true },
    { outcome: "fails a turn that never finishes", finishes: false },
  ])("keeps a plugin-owned turn running past a spent budget and $outcome", async ({ finishes }) => {
    const context = buildClaudeStreamJsonRunContext(`run-limit-plugin-${finishes}`);
    const record = { type: "system", subtype: "fixture_padding", padding: "x".repeat(1024 * 1024) };
    const recordChars = JSON.stringify(record).length + 1;
    let yielded = 0;
    let closed = false;
    let aborted = false;
    let abortedWhileStreaming: boolean | undefined;
    // Plugin transports still resolve the backend executable; keep that off the host PATH.
    context.preparedBackend.backend.command = process.execPath;
    context.executionTarget = {
      kind: "plugin",
      async *execute(execution) {
        execution.abortSignal?.addEventListener("abort", () => {
          aborted = true;
        });
        try {
          // Twelve records cross the 8 MiB budget; the CLI is still working past it.
          while (yielded < 12) {
            yielded += 1;
            yield record;
          }
          abortedWhileStreaming = aborted;
          if (finishes) {
            yield { type: "result", subtype: "success", is_error: false, result: "done" };
          }
        } finally {
          closed = true;
        }
      },
    };

    const run = executePreparedCliRun(context);
    if (finishes) {
      // Assembly stopped at the budget, yet the terminal result still lands.
      await expect(run).resolves.toMatchObject({ text: "done" });
    } else {
      // Without a terminal result the outcome is unknowable, so the turn fails.
      await expect(run).rejects.toThrow("CLI plugin runtime completed without a terminal result.");
    }
    // The budget is spent well before the last record, and none of them is cut off.
    expect(Math.floor(maxTurnRawChars / recordChars) + 1).toBeLessThan(yielded);
    expect(yielded).toBe(12);
    expect(abortedWhileStreaming).toBe(false);
    expect(closed).toBe(true);
  });
});
