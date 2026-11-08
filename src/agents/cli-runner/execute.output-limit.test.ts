// Exercise parser refusal through the real CLI process owner and supervised Node child.
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createProcessSupervisor } from "../../process/supervisor/supervisor.js";
import type { ManagedRun, SpawnInput } from "../../process/supervisor/types.js";
import { withTestRunAdmission } from "../admitted-run-context.test-support.js";
import { CLI_STREAM_JSON_OUTPUT_LIMITS } from "../cli-output-stream-limits.js";
import { executeDeps } from "./execute-deps.js";
import { createCliEventHandlers } from "./execute-events.js";
import { buildContext, buildToolTracking } from "./execute-events.tool-result-args.test-support.js";
import { executeCliProcess } from "./execute-process.js";
import { createCliRunCurrentAssertion } from "./execution-target.js";

const supervisors: ReturnType<typeof createProcessSupervisor>[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.shutdown()));
  vi.restoreAllMocks();
});

function fixture(runId: string) {
  const context = buildContext(runId);
  Object.assign(context.preparedBackend.backend, {
    command: process.execPath,
    serialize: false,
    jsonlDialect: "claude-stream-json",
  });
  context.params.timeoutMs = 4_000;
  context.params.executionMode = "side-question";
  context.workspaceDir = process.cwd();
  context.params.workspaceDir = process.cwd();
  const supervisor = createProcessSupervisor();
  supervisors.push(supervisor);
  const toolTracking = buildToolTracking();
  const events = createCliEventHandlers({
    context,
    toolTracking,
    getRunState: () => ({ failed: false, error: undefined }),
  });
  const run = () =>
    withTestRunAdmission(context.params, async (admittedRunContext) => {
      const original = context.params.admittedRunContext;
      context.params.admittedRunContext = admittedRunContext;
      try {
        return await executeCliProcess({
          context,
          assertCurrent: createCliRunCurrentAssertion(context.params),
          backend: context.preparedBackend.backend,
          deps: { ...executeDeps, getProcessSupervisor: () => supervisor },
          events,
          toolTracking,
          diagnostics: undefined,
          nodePlacement: null,
          useManagedClaudeLiveSession: false,
          useResume: false,
          executionCommand: process.execPath,
          executionLeadingArgv: [],
          resolveExecutionArgs: () => [
            "-e",
            "process.stdin.once('data', () => { process.stdout.write('x'.repeat(8388609)); setInterval(() => {}, 1000); });",
          ],
          env: { PATH: process.env.PATH ?? "" },
          prompt: "fixture",
          noOutputTimeoutMs: 4_000,
          outputMode: "jsonl",
          logOutputText: false,
          cliTurnStartedAt: Date.now(),
          observeForkSuccessor: () => {},
        });
      } finally {
        context.params.admittedRunContext = original;
      }
    });
  return { context, supervisor, run };
}

describe("CLI stream-json output refusal", () => {
  it.each(["before", "after"] as const)(
    "stops and settles the real child when refusal arrives %s handle assignment",
    async (when) => {
      const { supervisor, run } = fixture(`run-limit-${when}`);
      const spawn = supervisor.spawn.bind(supervisor);
      let managed: ManagedRun | undefined;
      let cancel: MockInstance<ManagedRun["cancel"]> | undefined;
      const refused = createDeferred();
      let bytes = 0;
      vi.spyOn(supervisor, "spawn").mockImplementation(async (input: SpawnInput) => {
        if (input.mode !== "child") {
          throw new Error("Expected child transport");
        }
        managed = await spawn({
          ...input,
          input: undefined,
          stdinMode: "pipe-open",
          onStdout: (chunk) => {
            input.onStdout?.(chunk);
            bytes += chunk.length;
            if (bytes > CLI_STREAM_JSON_OUTPUT_LIMITS.maxPendingLineChars) {
              refused.resolve();
            }
          },
        });
        cancel = vi.spyOn(managed, "cancel");
        if (when === "before") {
          managed.stdin?.write("go");
          await refused.promise;
        } else {
          const wait = managed.wait;
          let started = false;
          managed.wait = () => {
            if (!started) {
              started = true;
              managed?.stdin?.write("go");
            }
            return wait();
          };
        }
        return managed;
      });
      const started = performance.now();
      await expect(run()).rejects.toMatchObject({
        name: "FailoverError",
        reason: "format",
        message: "CLI JSONL line exceeded 8388608 characters; refusing to parse output.",
      });
      const elapsedMs = performance.now() - started;
      console.info(JSON.stringify({ scenario: when, elapsedMs, deadlineMs: 4_000 }));
      expect(elapsedMs).toBeLessThan(2_000);
      expect(cancel).toHaveBeenCalledExactlyOnceWith("manual-cancel");
      expect(managed?.activity.resultSettled).toBe(true);
      await managed?.waitForExtinction?.();
      expect(await managed?.wait()).toMatchObject({ reason: "manual-cancel", timedOut: false });
      console.info(JSON.stringify({ scenario: when, elapsedMs, deadlineMs: 4_000, settled: true }));
    },
  );

  it.each(["normal", "abort"] as const)("preserves the %s child outcome", async (kind) => {
    const { context, supervisor, run } = fixture("sibling");
    const controller = new AbortController();
    context.params.abortSignal = controller.signal;
    const spawn = supervisor.spawn.bind(supervisor);
    let managed: ManagedRun | undefined;
    vi.spyOn(supervisor, "spawn").mockImplementation(async (input) => {
      if (input.mode !== "child") {
        throw new Error("Expected child transport");
      }
      managed = await spawn({
        ...input,
        argv: [
          process.execPath,
          "-e",
          kind === "normal"
            ? 'console.log(JSON.stringify({type:"result",subtype:"success",result:"done"}))'
            : 'console.log("ready"); setInterval(() => {}, 1000)',
        ],
        resolveArgs: undefined,
        onStdout: (chunk) => {
          if (kind === "abort") {
            controller.abort();
          } else {
            input.onStdout?.(chunk);
          }
        },
      });
      return managed;
    });
    if (kind === "normal") {
      await expect(run()).resolves.toMatchObject({ text: "done" });
    } else {
      await expect(run()).rejects.toMatchObject({ name: "AbortError", message: "CLI run aborted" });
    }
    await managed?.waitForExtinction?.();
    expect(managed?.activity.resultSettled).toBe(true);
    expect(await managed?.wait()).toMatchObject({
      reason: kind === "normal" ? "exit" : "manual-cancel",
    });
  });

  it("closes a plugin turn immediately on parser refusal", async () => {
    const { context, run } = fixture("plugin-limit");
    const record = { type: "system", subtype: "fixture_padding", padding: "x".repeat(1024 * 1024) };
    let yielded = 0;
    let closed = false;
    let aborted = false;
    context.executionTarget = {
      kind: "plugin",
      async *execute(execution) {
        execution.abortSignal?.addEventListener("abort", () => {
          aborted = true;
        });
        try {
          while (yielded < 12) {
            yielded += 1;
            yield record;
          }
          yield { type: "result", subtype: "success", result: "done" };
        } finally {
          closed = true;
        }
      },
    };
    await expect(run()).rejects.toMatchObject({ name: "FailoverError", reason: "format" });
    expect(yielded).toBe(8);
    expect(closed).toBe(true);
    expect(aborted).toBe(true);
  });
});
