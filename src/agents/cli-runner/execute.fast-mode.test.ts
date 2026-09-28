import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliBackendResolveExecutionArgsContext } from "../../plugins/cli-backend.types.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

afterEach(() => {
  supervisorSpawnMock.mockReset();
  vi.useRealTimers();
});

describe("CLI backend resolveExecutionArgs fast mode", () => {
  it.each([
    [true, true],
    [false, false],
    ["auto", true],
    [undefined, undefined],
  ] as const)("resolves fastMode=%s to %s at execution", async (fastMode, expected) => {
    const resolveExecutionArgs = vi.fn((context: CliBackendResolveExecutionArgsContext) => [
      ...context.baseArgs,
    ]);
    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "fixture-model",
      thinkLevel: "high",
      fastMode,
      resolveExecutionArgs,
      backend: {
        command: "/bin/sh",
        args: ["exec", "--json"],
        output: "text",
        systemPromptFileArg: undefined,
        input: "stdin",
      },
    });
    supervisorSpawnMock.mockResolvedValue(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        stdout: "done",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "done" });

    expect(resolveExecutionArgs).toHaveBeenCalledTimes(1);
    const resolved = resolveExecutionArgs.mock.calls[0]?.[0];
    expect(resolved).toBeDefined();
    expect(resolved?.fastMode).toBe(expected);
    expect(resolved?.thinkingLevel).toBe("high");
    expect(resolved?.baseArgs).toEqual(["exec", "--json"]);
  });

  it("counts awaited backend setup against the automatic cutoff", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1000);
    const resolveExecutionArgs = vi.fn((context: CliBackendResolveExecutionArgsContext) => [
      ...context.baseArgs,
    ]);
    const context = buildPreparedCliRunContext({
      provider: "codex-cli",
      model: "fixture-model",
      fastMode: "auto",
      resolveExecutionArgs,
      backend: { command: "/bin/sh", args: ["exec"], output: "text", input: "stdin" },
    });
    context.params.fastModeAutoOnSeconds = 1;
    context.preparedBackend.beforeExecution = async () => {
      vi.setSystemTime(2001);
    };
    supervisorSpawnMock.mockResolvedValue(
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        stdout: "done",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    await expect(executePreparedCliRun(context)).resolves.toMatchObject({ text: "done" });
    expect(resolveExecutionArgs.mock.calls[0]?.[0].fastMode).toBe(false);
  });
});
