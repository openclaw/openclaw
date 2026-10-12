import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import * as worker from "./code-mode-executor.js";
import * as codeModeState from "./code-mode-state.js";
import { waitForPendingBridgeSettlement } from "./code-mode-state.js";
import type { SettledBridgeRequest } from "./code-mode-worker-types.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
  runUntilCompleted,
  waitUntilCompleted,
} from "./code-mode.test-support.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";

function harness(
  targets: AnyAgentTool[],
  options: Parameters<typeof createCodeModeHarness>[0] = {},
) {
  const fixture = createCodeModeHarness(options);
  applyCodeModeCatalog({ ...fixture.ctx, tools: [...fixture.tools, ...targets] });
  return { ...fixture, exec: fixture.tools[0]!, wait: fixture.tools[1]! };
}

afterEach(async () => {
  vi.useRealTimers();
  await resetCodeModeTestState();
});

describe("Code Mode wait, scope, and suspended runs", () => {
  it("keeps one execution allowance across event-driven required waits", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const releases = [createDeferred(), createDeferred()];
    const parked = [createDeferred(), createDeferred()];
    let calls = 0;
    const target = pluginToolWithExecute("required_step", "Required step", async () => {
      const index = calls++;
      await releases[index]!.promise;
      return jsonResult({ index });
    });
    const fixture = harness([target], { codeMode: { timeoutMs: 1_000 } });
    const runWorker = worker.runCodeModeExecutor;
    const grants: number[] = [];
    const workerSpy = vi
      .spyOn(worker, "runCodeModeExecutor")
      .mockImplementation(async (input, options) => {
        grants.push(input.config.timeoutMs);
        const result = await runWorker(input, options);
        // Controlled worker/checkpoint cost, not a real delay or waiting allowance.
        vi.advanceTimersByTime(100);
        return result;
      });
    const waitForSettlement = codeModeState.waitForPendingBridgeSettlement;
    let waits = 0;
    const waitSpy = vi
      .spyOn(codeModeState, "waitForPendingBridgeSettlement")
      .mockImplementation((...args) => {
        parked[waits++]?.resolve();
        return waitForSettlement(...args);
      });
    let settled = false;
    const execution = fixture.exec
      .execute("required-budget", {
        awaitResults: true,
        code: "const a = await required_step({}); const b = await required_step({}); return [a,b];",
      })
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      for (let index = 0; index < 2; index++) {
        await parked[index]!.promise;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(settled).toBe(false);
        expect(calls).toBe(index + 1);
        expect(testing.activeRuns.size).toBe(0);
        releases[index]!.resolve();
      }
      expect(resultDetails(await execution)).toMatchObject({
        status: "completed",
        value: [{ index: 0 }, { index: 1 }],
      });
      expect(grants).toEqual([1_000, 900, 800]);
      expect(waits).toBe(2);
      expect(target.execute).toHaveBeenCalledTimes(2);
    } finally {
      releases.forEach((release) => release.resolve());
      await execution;
      workerSpy.mockRestore();
      waitSpy.mockRestore();
    }
  });

  it.each(["failure", "cancel", "replace"] as const)(
    "settles required work on %s without late guest effects",
    async (outcome) => {
      const released = createDeferred();
      const parked = createDeferred();
      const target = pluginToolWithExecute("required_pending", "Required result", async () => {
        await released.promise;
        if (outcome === "failure") {
          throw new Error("required result failed");
        }
        return jsonResult({ complete: true });
      });
      const effect = pluginTool("after_required", "Effect after collection");
      const fixture = harness([target, effect]);
      const abort = new AbortController();
      const waitForSettlement = codeModeState.waitForPendingBridgeSettlement;
      const waitSpy = vi
        .spyOn(codeModeState, "waitForPendingBridgeSettlement")
        .mockImplementation((...args) => {
          parked.resolve();
          return waitForSettlement(...args);
        });
      const result = fixture.exec.execute(
        "required-lifetime",
        {
          awaitResults: true,
          code: "await required_pending({}); return await after_required({});",
        },
        abort.signal,
      );
      try {
        await parked.promise;
        if (outcome === "cancel") {
          abort.abort();
        } else if (outcome === "replace") {
          clearToolSearchCatalog(fixture.ctx);
        } else {
          released.resolve();
        }
        expect(resultDetails(await result)).toMatchObject({
          status: "failed",
          ...(outcome === "failure"
            ? { error: expect.stringContaining("required result failed") }
            : { code: "aborted" }),
        });
        released.resolve();
        const successor = harness([]);
        expect(
          resultDetails(await successor.exec.execute("new-owner", { code: "return 42;" })),
        ).toMatchObject({ status: "completed", value: 42 });
        expect(effect.execute).not.toHaveBeenCalled();
        expect(testing.activeRuns.size).toBe(0);
      } finally {
        released.resolve();
        await result;
        waitSpy.mockRestore();
      }
    },
  );

  it("does not turn guest timers into unlimited required-work waits", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const parked = createDeferred();
    const waitForSettlement = codeModeState.waitForPendingBridgeSettlement;
    const waitSpy = vi
      .spyOn(codeModeState, "waitForPendingBridgeSettlement")
      .mockImplementation((...args) => {
        parked.resolve();
        return waitForSettlement(...args);
      });
    const fixture = harness([], { codeMode: { timeoutMs: 1_000 } });
    const result = fixture.exec.execute("required-timer", {
      awaitResults: true,
      code: "await new Promise(resolve => setTimeout(resolve, 60_000)); return 1;",
    });
    try {
      await parked.promise;
      await vi.advanceTimersByTimeAsync(1_001);
      expect(resultDetails(await result)).toMatchObject({ status: "failed", code: "timeout" });
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      await result;
      waitSpy.mockRestore();
    }
  });

  it("refuses an unfinished explicit yield for required work", async () => {
    const fixture = harness([]);
    expect(
      resultDetails(
        await fixture.exec.execute("required-yield", {
          awaitResults: true,
          code: "await yield_control(); return 1;",
        }),
      ),
    ).toMatchObject({
      status: "failed",
      error: expect.stringContaining("cannot yield an unfinished program"),
    });
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([
    { mode: "inline", outcome: "approve" },
    { mode: "yield", outcome: "approve" },
    { mode: "yield", outcome: "cancel" },
    { mode: "yield", outcome: "close" },
  ] as const)(
    "keeps $mode approval paused until $outcome without extending its budget",
    async ({ mode, outcome }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const timeoutMs = 1_000;
      const callAbort = new AbortController();
      const requested = createDeferred();
      const decision = createDeferred();
      const resumed = createDeferred();
      const continuationBudgets: number[] = [];
      const runWorker = worker.runCodeModeExecutor;
      let restoreCharged = false;
      const workerSpy = vi
        .spyOn(worker, "runCodeModeExecutor")
        .mockImplementation(async (input, options) => {
          const inlineHost = options.inlineHost;
          if (!inlineHost) {
            return await runWorker(input, options);
          }
          return await runWorker(input, {
            ...options,
            inlineHost: {
              ...inlineHost,
              onBoundary: async (...args) => {
                if (mode === "yield" && input.kind === "resume" && !restoreCharged) {
                  restoreCharged = true;
                  await vi.advanceTimersByTimeAsync(100);
                  resumed.resolve();
                }
                const command = await inlineHost.onBoundary(...args);
                if (command.kind === "continue") {
                  continuationBudgets.push(command.timeoutMs);
                }
                return command;
              },
            },
          });
        });
      const shell = pluginToolWithExecute("exec", "Run shell", async (toolCallId) => {
        const event = {
          runId: fixture.ctx.runId,
          sessionId: fixture.ctx.sessionId,
          stream: "lifecycle" as const,
        };
        emitAgentEvent({
          ...event,
          data: { phase: "waiting-approval", approvalId: "approval", toolCallId },
        });
        requested.resolve();
        await decision.promise;
        emitAgentEvent({
          ...event,
          data: { phase: "approval-resolved", approvalId: "approval", toolCallId },
        });
        return jsonResult({ status: "completed", aggregated: "approved" });
      });
      const fixture = harness([shell], { codeMode: { timeoutMs } });
      const { runId, sessionKey } = fixture.ctx;
      const admission = prepareAgentRunAdmission({
        cfg: {},
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "system", boundary: "code-mode-approval", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef(runId),
      });
      const admittedRunContext = await admission.admit("embedded");
      const identity = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext,
        agentId: "main",
        sessionKey,
        turnSourceChannel: "telegram",
      });
      let settled = false;
      try {
        const execution = withGatewayToolCallerIdentity(identity, async () => {
          let result = await fixture.exec.execute("inline-approval", {
            code:
              mode === "inline"
                ? 'return await exec({ value: "approval" });'
                : 'const pending = exec({ value: "approval" }); await yield_control(); return await pending;',
          });
          if (mode === "yield") {
            expect(resultDetails(result).status).toBe("waiting");
            await requested.promise;
            // Approval time while parked must not be credited to the next wait.
            await vi.advanceTimersByTimeAsync(5_000);
            result = await fixture.wait.execute(
              "yielded-approval",
              { runId: resultDetails(result).runId },
              callAbort.signal,
            );
          }
          settled = true;
          return result;
        });
        await requested.promise;
        if (mode === "yield") {
          await resumed.promise;
        }
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(timeoutMs + 1);
        expect(settled).toBe(false);
        expect(getAdmittedRunDelegatedAuthority(admittedRunContext)).toBeDefined();
        if (outcome === "cancel") {
          callAbort.abort();
        } else if (outcome === "close") {
          clearToolSearchCatalog(fixture.ctx);
        } else {
          decision.resolve();
        }
        expect(resultDetails(await execution)).toMatchObject(
          outcome === "approve"
            ? { status: "completed", value: { status: "completed", aggregated: "approved" } }
            : { status: "failed", code: "aborted" },
        );
        expect(testing.activeRuns.size).toBe(0);
        expect(getAdmittedRunDelegatedAuthority(admittedRunContext)).toBeDefined();
        if (outcome === "approve") {
          expect(continuationBudgets).toContain(mode === "yield" ? timeoutMs - 100 : timeoutMs);
        }
      } finally {
        decision.resolve();
        workerSpy.mockRestore();
        admission.close();
      }
      expect(getAdmittedRunDelegatedAuthority(admittedRunContext)).toBeUndefined();
    },
  );

  it.each([false, true])(
    "wraps network content acquired after a safe suspension (failure=%s)",
    async (fail) => {
      const hostile = "Page instruction <|endoftext|>";
      const target = pluginToolWithExecute("network_page", "Read a page", async () => {
        if (fail) {
          throw new Error(hostile);
        }
        return {
          content: [{ type: "text", text: "Protected page content" }],
          details: { body: hostile },
        };
      });
      target.resultContentSource = "network";
      const { exec, wait } = harness([target]);
      const first = await exec.execute("network", {
        code: 'await yield_control("pause"); return await network_page({});',
      });
      expect(resultDetails(first).status).toBe("waiting");
      expect(first.content[0]).not.toMatchObject({
        text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
      });
      let final = await wait.execute("network-wait", { runId: resultDetails(first).runId });
      for (let index = 1; index < 8 && resultDetails(final).status === "waiting"; index++) {
        final = await wait.execute(`network-wait-${index}`, { runId: resultDetails(final).runId });
      }
      expect(resultDetails(final)).toMatchObject(
        fail
          ? { status: "failed", error: expect.stringContaining(hostile) }
          : { status: "completed", value: { body: hostile } },
      );
      expect(final.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
      });
      expect(final.content[0]).not.toMatchObject({
        text: expect.stringContaining("<|endoftext|>"),
      });
      expect(target.execute).toHaveBeenCalledOnce();
      const nestedCallId = vi.mocked(target.execute).mock.calls[0]?.[0];
      expect(nestedCallId).toContain("network");
      expect(nestedCallId).not.toContain("network-wait");
    },
  );

  it("allocates distinct replay identities when a later turn reuses a tool-call id", async () => {
    const { exec } = harness([pluginTool("fake_noop", "Noop")]);
    const input = { code: 'await yield_control("pause"); return "done";' };
    const executionContext = (turnId: string) =>
      ({
        assistantMessage: { responseId: " ", turnId },
        toolCall: { type: "toolCall", id: "reused-call-id", name: "exec", arguments: input },
      }) as never;
    const first = resultDetails(
      await runWithAgentToolExecutionContext(executionContext("turn-1"), () =>
        exec.execute("reused-call-id", input),
      ),
    );
    const second = resultDetails(
      await runWithAgentToolExecutionContext(executionContext("turn-2"), () =>
        exec.execute("reused-call-id", input),
      ),
    );
    expect(first.status).toBe("waiting");
    expect(second.status).toBe("waiting");
    expect(second.runId).not.toBe(first.runId);
    expect(testing.activeRuns.size).toBe(2);
    expect(new Set([...testing.activeRuns.values()].map((state) => state.replayId)).size).toBe(2);
  });

  it("keeps an admitted wait alive past idle expiry and expires it only after reparking", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    const timeoutMs = 10_000;
    const started = createDeferred<AbortSignal | undefined>();
    const completion = createDeferred();
    const target = pluginToolWithExecute(
      "slow_action",
      "Complete one action",
      async (_id, _input, signal) => {
        started.resolve(signal);
        await completion.promise;
        return jsonResult({ delivered: true });
      },
    );
    const { exec, wait } = harness([target], { codeMode: { timeoutMs, snapshotTtlSeconds: 1 } });
    try {
      const execution = exec.execute("expiry", { code: "return await slow_action({});" });
      const signal = expectDefined(await started.promise, "nested cancellation signal");
      await vi.advanceTimersByTimeAsync(timeoutMs);
      const first = resultDetails(await execution);
      expect(first.status).toBe("waiting");
      await vi.advanceTimersByTimeAsync(500);
      const waiting = wait.execute("active-wait", { runId: first.runId });
      await vi.advanceTimersByTimeAsync(timeoutMs);
      expect(signal.aborted).toBe(false);
      const parked = resultDetails(await waiting);
      expect(parked).toMatchObject({ status: "waiting", runId: first.runId });
      await vi.advanceTimersByTimeAsync(999);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      await expect(wait.execute("expired-wait", { runId: parked.runId })).rejects.toThrow(
        "code mode run is unavailable or expired",
      );
      expect(target.execute).toHaveBeenCalledOnce();
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      completion.resolve();
    }
  });

  it("preserves accepted output when wait expiry exceeds the Date range", async () => {
    const target = pluginTool("expiry_fixture", "Expiry fixture");
    const { exec, wait } = harness([target], { codeMode: { snapshotTtlSeconds: 1 } });
    const limit = 8_640_000_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(limit - 1_000);
    let details: Record<string, unknown>;
    try {
      const input = {
        code: `text("delivered"); await yield_control();
        text("accepted first"); await expiry_fixture({}); text("accepted inline"); await yield_control("pause"); return "done";`,
      };
      const first = resultDetails(await exec.execute("park", input));
      expect(first).toMatchObject({
        status: "waiting",
        output: [{ type: "text", text: "delivered" }],
      });
      now.mockReturnValue(limit - 1);
      details = resultDetails(await wait.execute("resume", { runId: first.runId }));
    } finally {
      now.mockRestore();
    }
    expect(details).toMatchObject({
      status: "failed",
      error: "code mode run expiry is unavailable.",
      output: [
        { type: "text", text: "accepted first" },
        { type: "text", text: "accepted inline" },
      ],
    });
    expect(target.execute).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(0);
  });

  describe("suspended-run owner scope", () => {
    const identities = ["runId", "sessionId", "sessionKey", "agentId"] as const;
    const rejections = new Map<(typeof identities)[number], string>();
    let rightfulResult: Record<string, unknown>;
    beforeAll(async () => {
      const { ctx, exec, wait } = harness([pluginTool("fake_noop", "Noop")], { agentId: "owner" });
      const first = resultDetails(
        await exec.execute("scoped", {
          code: 'await yield_control("pause"); return "owner-secret";',
        }),
      );
      expect(first.status).toBe("waiting");
      for (const missing of identities) {
        const foreign = createCodeModeTools({ ...ctx, [missing]: undefined })[1]!;
        try {
          await foreign.execute("missing-owner", { runId: first.runId });
          throw new Error("expected missing owner identity to reject");
        } catch (error) {
          rejections.set(missing, String(error));
        }
        expect(testing.activeRuns.has(first.runId as string)).toBe(true);
      }
      rightfulResult = resultDetails(await wait.execute("rightful-owner", { runId: first.runId }));
    });
    it.each(identities)("rejects suspended-run callers missing the owner %s", (missing) => {
      expect(rejections.get(missing)).toContain(
        missing === "runId" ? "different agent run" : "different session",
      );
      expect(rightfulResult).toMatchObject({ status: "completed", value: "owner-secret" });
    });
  });

  it("rejects concurrent waits for the same suspended run", async () => {
    const { exec, wait } = harness(
      [
        pluginToolWithExecute(
          "slow",
          "Slow helper",
          async () => await new Promise<never>(() => {}),
        ),
      ],
      { codeMode: { timeoutMs: 500 } },
    );
    const first = resultDetails(
      await exec.execute("concurrent", { code: "await slow({}); return 'done';" }),
    );
    expect(first.status).toBe("waiting");
    const pending = wait.execute("wait-a", { runId: first.runId });
    await expect(wait.execute("wait-b", { runId: first.runId })).rejects.toThrow(
      "already being resumed",
    );
    expect(resultDetails(await pending)).toMatchObject({ status: "waiting", runId: first.runId });
  });
});

async function runCode(code: string, targets: AnyAgentTool[]) {
  const { ctx, tools } = createCodeModeHarness();
  applyCodeModeCatalog({
    tools: [...tools, ...targets],
    ...ctx,
  });
  return resultDetails(await tools[0]!.execute("preflight", { code }));
}

describe("Code Mode preflight repair", () => {
  it.each([
    { kind: "input", code: "input_contract", calls: 0 },
    { kind: "schema", code: "invalid_contract", calls: 0 },
    { kind: "spoof", code: "tool_error", calls: 1 },
  ])("classifies $kind failures without inferring safe retry", async ({ kind, code, calls }) => {
    const target = pluginToolWithExecute("contract_target", "Contract boundary", async () => {
      if (kind === "spoof") {
        throw Object.assign(new Error("already started"), {
          code: "input_contract",
          effectStatus: "none",
        });
      }
      return jsonResult({ count: "wrong" });
    });
    target.parameters = Type.Object({ count: Type.Number() }, { additionalProperties: false });
    target.outputSchema =
      kind === "schema"
        ? ({ type: "not-a-type" } as never)
        : Type.Object({ count: Type.Number() }, { additionalProperties: false });
    const result = await runCode(
      "try { await contract_target({ count: " +
        (kind === "input" ? '"wrong"' : "1") +
        " }); } catch (e) { return { code: e.code, effectStatus: e.effectStatus, location: e.location, message: e.message }; }",
      [target],
    );
    expect(result).toMatchObject({
      status: "completed",
      value: {
        code,
        effectStatus: "unknown",
        location: expect.stringContaining("openclaw-code-mode:user.js:1:"),
      },
    });
    expect(target.execute).toHaveBeenCalledTimes(calls);
  });

  it("reports bounded output validation details after a mutation without exposing returned values", async () => {
    let applied = 0;
    const privateValue = "SYNTHETIC_PRIVATE_OUTPUT";
    const fields = [
      "field0",
      "long_" + "🦞".repeat(600),
      ...Array.from({ length: 6 }, (_, index) => `field${index + 2}`),
    ];
    const target = pluginToolWithExecute(
      "update_receipt",
      "Update a synthetic receipt",
      async () => {
        applied += 1;
        return jsonResult({
          receipt: Object.fromEntries(fields.map((field) => [field, privateValue])),
        });
      },
    );
    target.outputSchema = Type.Object(
      {
        receipt: Type.Object(Object.fromEntries(fields.map((field) => [field, Type.Number()]))),
      },
      { additionalProperties: false },
    );

    const details = await runCode(
      "try { await update_receipt({}); } catch (e) { return { code:e.code, effectStatus:e.effectStatus, message:e.message }; }",
      [target],
    );

    expect(applied).toBe(1);
    expect(target.execute).toHaveBeenCalledOnce();
    expect(details).toMatchObject({
      status: "completed",
      value: {
        code: "output_contract",
        effectStatus: "unknown",
        message: expect.stringContaining("receipt.field0: must be number"),
      },
    });
    const message = JSON.stringify(details.value);
    expect(message).toContain("tool returned");
    expect(message).toContain("Check current state before retrying");
    expect(message).toContain("additional validation issues omitted");
    expect(message).toContain("[truncated]");
    expect(message).not.toContain(privateValue);
    expect(Buffer.byteLength(message, "utf8")).toBeLessThan(2048);
  });

  it("rejects stale exec timeout input before starting the command", async () => {
    const exec = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const execute = vi.spyOn(exec, "execute");

    const details = await runCode('await exec({ command: "printf ok", timeout: 5 });', [exec]);

    expect(execute).not.toHaveBeenCalled();
    expect(details).toMatchObject({
      status: "failed",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
    });
    expect(details.error).toContain("timeout");
  });
});

describe("Code Mode program data", () => {
  async function run(tools: AnyAgentTool[], code: string) {
    const h = createCodeModeHarness({ codeMode: { maxOutputBytes: 1024 } });
    applyCodeModeCatalog({
      ...h.ctx,
      tools: [...h.tools, ...tools],
    });
    return runUntilCompleted({ execTool: h.tools[0]!, waitTool: h.tools[1]!, code });
  }

  it("refuses aggregate overflow across a parked boundary", async () => {
    const bytes = 6 * 1024 * 1024;
    const tool = pluginToolWithExecute("large_page", "Read a large page", async () =>
      jsonResult("x".repeat(bytes)),
    );
    const code =
      "const pages = Promise.allSettled([large_page({}), large_page({})]); " +
      "await yield_control(); " +
      'return (await pages).map(item => item.status === "fulfilled" ? { length: item.value.length } : { error: item.reason.message });';
    const result = await run([tool], code);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "completed",
      value: [
        { length: bytes },
        { error: expect.stringMatching(/program-data budget exceeded.*Paginate/) },
      ],
    });
    expect(tool.execute).toHaveBeenCalledTimes(2);
  });
});

it("clears host and worker-input aliases after bridge settlement", async () => {
  const original = worker.runCodeModeExecutor;
  const arrays: SettledBridgeRequest[][] = [];
  const aliases: SettledBridgeRequest[] = [];
  const spy = vi.spyOn(worker, "runCodeModeExecutor").mockImplementation(async (input, ...args) => {
    // Production owns the worker input; retain its exact aliases to detect premature accounting-only release.
    const resume = input as { kind: string; settledRequests?: SettledBridgeRequest[] };
    if (resume.kind === "resume" && resume.settledRequests) {
      arrays.push(resume.settledRequests);
      aliases.push(...resume.settledRequests);
    }
    return await original(input, ...args);
  });
  const h = createCodeModeHarness();
  const success = pluginToolWithExecute("reply_success", "Read data", async () =>
    jsonResult("x".repeat(200000)),
  );
  const failure = pluginToolWithExecute("reply_failure", "Fail", async () => {
    throw new Error("failure:" + "x".repeat(200000));
  });
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, success, failure] });
  try {
    const first = resultDetails(
      await h.tools[0]!.execute("aliases", {
        code: "const replies = Promise.allSettled([reply_success({}), reply_failure({})]); await yield_control(); return (await replies).map(reply => reply.status);",
      }),
    );
    expect(first.status).toBe("waiting");
    const retainedState = testing.activeRuns.get(String(first.runId))!;
    await waitForPendingBridgeSettlement(retainedState.pending, {
      kind: "draining",
      requiredRequestIds: retainedState.pending.map((entry) => entry.id),
    });
    const final = await waitUntilCompleted({ details: first, waitTool: h.tools[1]! });
    expect(final).toMatchObject({ status: "completed", value: ["fulfilled", "rejected"] });
    expect(aliases.some((reply) => reply.ok)).toBe(true);
    expect(aliases.some((reply) => !reply.ok)).toBe(true);
    expect(arrays.every((array) => array.length === 0)).toBe(true);
    expect(aliases.every((reply) => reply.json === "")).toBe(true);
    for (const pending of retainedState.pending) {
      expect(pending.settled).toBe(true);
      expect(() => pending.reply.take()).toThrow("unavailable");
    }
  } finally {
    spy.mockRestore();
    clearToolSearchCatalog(h.ctx);
  }
});

it.each(["cancel", "expiry"])(
  "does not retain a late tool completion after parked %s",
  async (close) => {
    const started = createDeferred();
    const release = createDeferred();
    const finished = createDeferred();
    const h = createCodeModeHarness();
    const tool = pluginToolWithExecute("late_page", "Signal-ignoring data source", async () => {
      started.resolve();
      await release.promise;
      finished.resolve();
      return jsonResult("late".repeat(300000));
    });
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
    try {
      const first = resultDetails(
        await h.tools[0]!.execute("late", {
          code: "const page = late_page({}); await yield_control(); return (await page).length;",
        }),
      );
      expect(first.status).toBe("waiting");
      await started.promise;
      const retained = testing.activeRuns.get(String(first.runId))!;
      if (close === "expiry") {
        testing.removeExpiredRuns(retained.expiresAt + 1);
      } else {
        clearToolSearchCatalog(h.ctx);
      }
      await waitForPendingBridgeSettlement(retained.pending, {
        kind: "draining",
        requiredRequestIds: retained.pending.map((entry) => entry.id),
      });
      release.resolve();
      await finished.promise;
      await Promise.resolve();
      expect(retained.owner.signal.aborted).toBe(true);
      expect(testing.activeRuns.size).toBe(0);
      for (const pending of retained.pending) {
        expect(() => pending.reply.take()).toThrow("unavailable");
      }
      expect(tool.execute).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      clearToolSearchCatalog(h.ctx);
    }
  },
);

it("releases each guest-discarded timer lease before the cell closes", async () => {
  const h = createCodeModeHarness();
  applyCodeModeCatalog({ ...h.ctx, tools: h.tools });
  try {
    let result = resultDetails(
      await h.tools[0]!.execute("discarded-timers", {
        code: `for (let i = 0; i < 6; i++) {
        const timer = setTimeout(() => { throw new Error("discarded timer fired"); }, 60_000);
        await yield_control("armed");
        clearTimeout(timer);
        await yield_control("cleared");
      }
      return "done";`,
      }),
    );
    for (let round = 0; round < 6; round++) {
      expect(result.status).toBe("waiting");
      const parked = testing.activeRuns.get(String(result.runId))!;
      const timer = parked.pending.find((entry) => entry.method === "sleep")!;
      expect(timer).toBeDefined();
      expect(timer.settled).toBeUndefined();
      const release = vi.spyOn(timer.reply, "release");
      result = resultDetails(await h.tools[1]!.execute("discard-timer", { runId: result.runId }));
      expect(result.status).toBe("waiting");
      expect(parked.owner.signal.aborted).toBe(false);
      expect(release).toHaveBeenCalledOnce();
      expect(() => timer.reply.take()).toThrow("unavailable");
      expect(
        testing.activeRuns
          .get(String(result.runId))!
          .pending.some((entry) => entry.id === timer.id),
      ).toBe(false);
      release.mockRestore();
      result = resultDetails(await h.tools[1]!.execute("next-timer", { runId: result.runId }));
    }
    expect(result).toMatchObject({ status: "completed", value: "done" });
  } finally {
    clearToolSearchCatalog(h.ctx);
    vi.restoreAllMocks();
  }
});
