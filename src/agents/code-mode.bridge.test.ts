/** Tests Code Mode bridge settlement and cancellation. */

import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../shared/deferred.js";
import { buildBlockedToolResult } from "./agent-tools.before-tool-call.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { CODE_MODE_REPAIR_EVIDENCE } from "./code-mode-repair-evidence.js";
import { cloneCodeModeStats } from "./code-mode-stats.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  resetCodeModeTestState,
  pluginTool,
  pluginToolWithExecute,
  resultDetails,
  createCodeModeHarness,
  runUntilCompleted,
  testing,
} from "./code-mode.test-support.js";
import { createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult, ToolInputError } from "./tools/common.js";

describe("Code Mode bridge settlement and cancellation", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetCodeModeTestState();
  });

  it("drains a nested combinator after its outer race wins", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    let nestedAborted = false;
    const never = pluginToolWithExecute(
      "fake_nested_race_never",
      "Never-settling nested race helper",
      async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              nestedAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return jsonResult({ winner: "nested" });
      },
    );
    const fast = pluginToolWithExecute(
      "fake_nested_race_fast",
      "Fast nested race helper",
      async () => jsonResult({ winner: "fast" }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, never, fast],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-nested-combinator-race",
        {
          code: `return await Promise.race([
            Promise.all([tools.callValue("fake_nested_race_never", {})]),
            tools.callValue("fake_nested_race_fast", {}),
          ]);`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
    expect(never.execute).toHaveBeenCalledOnce();
    expect(fast.execute).toHaveBeenCalledOnce();
    expect(nestedAborted).toBe(false);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("resolves sequential bridge tool calls inline within one exec instead of a wait per call", async () => {
    const catalogRef = createToolSearchCatalogRef();
    // The host limit spans the whole run; sequential awaits must drain inline.
    const config = {
      tools: { codeMode: { enabled: true, maxPendingToolCalls: 2 } },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    const ticket = pluginTool("fake_create_ticket", "Create a fake ticket");
    applyCodeModeCatalog({
      tools: [...codeModeTools, ticket],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    // Five separate awaits would each suspend to the model under a wait-per-call
    // design; inline resumption collapses them into a single completed exec so
    // the model spends one turn instead of six.
    const details = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-inline",
        {
          code: `
            const ids = [];
            for (let index = 0; index < 5; index += 1) {
              const called = await tools.callValue("fake_create_ticket", { value: index });
              ids.push(called.input.value);
            }
            return ids;
          `,
        },
      ),
    );

    expect(details.status).toBe("completed");
    expect(details.value).toEqual([0, 1, 2, 3, 4]);
    expect(ticket.execute).toHaveBeenCalledTimes(5);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("queues bridge calls above the host concurrency limit without dropping them", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: { codeMode: { enabled: true, maxPendingToolCalls: 2 } },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    let active = 0;
    let peakActive = 0;
    const bounded = pluginToolWithExecute(
      "fake_bounded",
      "Bounded concurrency helper",
      async (_toolCallId, input) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10);
        });
        active -= 1;
        return jsonResult(input);
      },
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, bounded],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-bounded",
        {
          code: `return await Promise.all(
            Array.from({ length: 5 }, (_, index) =>
              tools.callValue("fake_bounded", { index }),
            ),
          );`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed" });
    expect(details.value).toEqual([
      { index: 0 },
      { index: 1 },
      { index: 2 },
      { index: 3 },
      { index: 4 },
    ]);
    expect(bounded.execute).toHaveBeenCalledTimes(5);
    expect(peakActive).toBe(2);
    const stats = cloneCodeModeStats(
      expectDefined(catalogRef.current?.codeModeStats, "Code Mode stats test invariant"),
    );
    expect(stats).toMatchObject({
      controlCalls: { exec: 1 },
      bridgeCalls: { callValue: 5 },
      workerRuns: {
        exec: { count: 1 },
        resume: { count: 2 },
      },
      bridgeLifecycle: {
        registered: 5,
        started: 5,
        settled: 5,
        unresolvedAtExtraction: 0,
      },
      snapshots: { count: 2 },
      outcomes: { completed: 1 },
    });
    expect(stats.workerRuns.exec?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(stats.workerRuns.resume?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(stats.snapshots?.totalBytes).toBeGreaterThan(0);
    expect(stats.snapshots?.maxBytes).toBeGreaterThan(0);
    expect(stats.snapshots?.serializationMs).toBeGreaterThanOrEqual(0);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("aborts active bridge work without starting queued calls", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const config = {
      tools: { codeMode: { enabled: true, maxPendingToolCalls: 1, timeoutMs: 30_000 } },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    const activeStarted = createDeferred();
    let activeAborted = false;
    const activeTool = pluginToolWithExecute(
      "fake_active_cancel",
      "Active cancellation helper",
      async (_toolCallId, _input, signal) => {
        activeStarted.resolve();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              activeAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return jsonResult({ done: true });
      },
    );
    const queuedTool = pluginTool("fake_queued_cancel", "Queued cancellation helper");
    applyCodeModeCatalog({
      tools: [...codeModeTools, activeTool, queuedTool],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const controller = new AbortController();
    const resultPromise = expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
      "code-call-queued-cancel",
      {
        code: `return await Promise.all([
          tools.callValue("fake_active_cancel", {}),
          tools.callValue("fake_queued_cancel", {}),
        ]);`,
      },
      controller.signal,
    );
    await activeStarted.promise;
    controller.abort();
    const details = resultDetails(await resultPromise);

    expect(details).toMatchObject({
      status: "failed",
      code: "aborted",
      error: "code mode execution aborted",
    });
    expect(activeTool.execute).toHaveBeenCalledOnce();
    expect(activeAborted).toBe(true);
    expect(queuedTool.execute).not.toHaveBeenCalled();
    expect(
      cloneCodeModeStats(
        expectDefined(catalogRef.current?.codeModeStats, "Code Mode stats test invariant"),
      ),
    ).toMatchObject({
      bridgeCalls: { callValue: 2 },
      bridgeLifecycle: {
        registered: 2,
        started: 1,
        settled: 1,
        cancelRequested: 2,
        cancelledBeforeStart: 1,
        unresolvedAtExtraction: 1,
      },
      outcomes: { aborted: 1 },
    });
    expect(testing.activeRuns.size).toBe(0);
  });

  it("keeps the actual winner when the later-started nested tool settles first", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    let firstAborted = false;
    const first = pluginToolWithExecute(
      "fake_first",
      "Earlier slow helper",
      async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              firstAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return jsonResult({ winner: "first" });
      },
    );
    const second = pluginToolWithExecute("fake_second", "Later fast helper", async () =>
      jsonResult({ winner: "second" }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, first, second],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-later-winner",
        {
          code: `return await Promise.race([
            tools.callValue("fake_first", {}),
            tools.callValue("fake_second", {}),
          ]);`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: { winner: "second" } });
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
    expect(firstAborted).toBe(false);
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each([
    {
      label: "directly",
      auditCode: 'void tools.callValue("fake_early_audit", {});',
    },
    {
      label: "in a detached already-settled Promise.race",
      auditCode: 'void Promise.race([tools.callValue("fake_early_audit", {}), Promise.resolve()]);',
    },
    {
      label: "in a detached Promise.all",
      auditCode: 'void Promise.all([tools.callValue("fake_early_audit", {})]);',
    },
    {
      label: "in a detached Promise.allSettled",
      auditCode: 'void Promise.allSettled([tools.callValue("fake_early_audit", {})]);',
    },
    {
      label: "in a detached Promise.any",
      auditCode: 'void Promise.any([tools.callValue("fake_early_audit", {})]);',
    },
    {
      label: "in a detached Promise.race",
      auditCode: 'void Promise.race([tools.callValue("fake_early_audit", {})]);',
    },
  ])(
    "drains a detached audit started $label before an awaited nested call",
    async ({ auditCode }) => {
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      let auditCompleted = false;
      let auditAborted = false;
      const auditStarted = createDeferred();
      const auditRelease = createDeferred();
      const audit = pluginToolWithExecute(
        "fake_early_audit",
        "Early detached audit",
        async (_toolCallId, _input, signal) => {
          auditStarted.resolve();
          signal?.addEventListener("abort", () => (auditAborted = true), { once: true });
          await auditRelease.promise;
          auditCompleted = true;
          return jsonResult({ recorded: true });
        },
      );
      const fast = pluginToolWithExecute("fake_awaited_fast", "Awaited fast helper", async () => {
        await auditStarted.promise;
        setImmediate(() => auditRelease.resolve());
        return jsonResult({ winner: "fast" });
      });
      applyCodeModeCatalog({
        tools: [...codeModeTools, audit, fast],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const details = resultDetails(
        await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
          "code-call-early-detached-audit",
          {
            code: `${auditCode}
            return await tools.callValue("fake_awaited_fast", {});`,
          },
        ),
      );

      expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
      expect(audit.execute).toHaveBeenCalledOnce();
      expect(fast.execute).toHaveBeenCalledOnce();
      expect(auditCompleted).toBe(true);
      expect(auditAborted).toBe(false);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("drains a race winner's detached audit and its slower race branch", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    let loserAborted = false;
    const winner = pluginToolWithExecute("fake_race_winner", "Race winner", async () =>
      jsonResult({ winner: "fast" }),
    );
    const loser = pluginToolWithExecute(
      "fake_race_loser",
      "Race loser",
      async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              loserAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return jsonResult({ winner: "slow" });
      },
    );
    const audit = pluginToolWithExecute("fake_race_audit", "Detached audit", async () =>
      jsonResult({ recorded: true }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, winner, loser, audit],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-race-detached-audit",
        {
          code: `return Promise.race([
            tools.callValue("fake_race_winner", {}),
            tools.callValue("fake_race_loser", {}),
          ]).then((value) => {
            void tools.callValue("fake_race_audit", {});
            return value;
          });`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
    expect(winner.execute).toHaveBeenCalledOnce();
    expect(loser.execute).toHaveBeenCalledOnce();
    expect(audit.execute).toHaveBeenCalledOnce();
    expect(loserAborted).toBe(false);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("drains every detached nested tool before completing the guest", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const first = pluginToolWithExecute("fake_detached_first", "First detached helper", async () =>
      jsonResult({ name: "first" }),
    );
    const second = pluginToolWithExecute(
      "fake_detached_second",
      "Second detached helper",
      async () => jsonResult({ name: "second" }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, first, second],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-detached",
        {
          code: `void tools.callValue("fake_detached_first", {});
            void tools.callValue("fake_detached_second", {});
            return "done";`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: "done" });
    expect(first.execute).toHaveBeenCalledOnce();
    expect(second.execute).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(0);
  });

  it.each(["race", "any"] as const)(
    "preserves the Promise.%s winner while draining the slower nested tool",
    async (combinator) => {
      const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
      let slowAborted = false;
      let slowCompleted = false;
      const fast = pluginToolWithExecute("fake_fast", "Fast helper", async () =>
        jsonResult({ winner: "fast" }),
      );
      const slow = pluginToolWithExecute(
        "fake_slow",
        "Slow helper",
        async (_toolCallId, _input, signal) => {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 25);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                slowAborted = true;
                reject(new Error("aborted"));
              },
              { once: true },
            );
          });
          slowCompleted = true;
          return jsonResult({ winner: "slow" });
        },
      );
      applyCodeModeCatalog({
        tools: [...codeModeTools, fast, slow],
        config,
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
        catalogRef,
      });

      const details = resultDetails(
        await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
          `code-call-${combinator}-fast`,
          {
            code: `return await Promise.${combinator}([
              tools.callValue("fake_fast", {}),
              tools.callValue("fake_slow", {}),
            ]);`,
          },
        ),
      );

      expect(details).toMatchObject({ status: "completed", value: { winner: "fast" } });
      expect(fast.execute).toHaveBeenCalledOnce();
      expect(slow.execute).toHaveBeenCalledOnce();
      expect(slowCompleted).toBe(true);
      expect(slowAborted).toBe(false);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("preserves fail-fast Promise.all while draining the slower nested tool", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    let slowAborted = false;
    let slowCompleted = false;
    const failed = pluginToolWithExecute("fake_failed", "Failed helper", async () => {
      throw new Error("fast failure");
    });
    const slow = pluginToolWithExecute(
      "fake_slow",
      "Slow helper",
      async (_toolCallId, _input, signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 25);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              slowAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        slowCompleted = true;
        return jsonResult({ winner: "slow" });
      },
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, failed, slow],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-fail-fast",
        {
          code: `try {
            await Promise.all([
              tools.callValue("fake_failed", {}),
              tools.callValue("fake_slow", {}),
            ]);
            return "unexpected success";
          } catch (error) {
            return error.message;
          }`,
        },
      ),
    );

    expect(details).toMatchObject({ status: "completed", value: "fast failure" });
    expect(failed.execute).toHaveBeenCalledOnce();
    expect(slow.execute).toHaveBeenCalledOnce();
    expect(slowCompleted).toBe(true);
    expect(slowAborted).toBe(false);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("marks failures after nested tool dispatch as non-retryable bridge failures", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const sideEffect = pluginToolWithExecute("fake_side_effect", "Side effect", async () =>
      jsonResult({ ok: true }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, sideEffect],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-post-dispatch-failure",
        {
          code: `
            await tools.callValue("fake_side_effect", {});
            throw new Error("after dispatch");
          `,
        },
      ),
    );

    expect(sideEffect.execute).toHaveBeenCalledOnce();
    expect(details).toMatchObject({
      status: "failed",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
    });
  });

  it("authenticates the exact rejected bridge preflight without serializing repair evidence", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const exec = createExecTool({ security: "full", ask: "off" });
    exec.execute = vi.fn(exec.execute.bind(exec)) as typeof exec.execute;
    applyCodeModeCatalog({
      tools: [...codeModeTools, exec],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      toolHookContext: {
        agentId: "main",
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
      },
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-trusted-preflight",
        {
          code: `
            return await tools.callValue("exec", {
              command: "printf should-not-run",
              host: "sandbox",
            });
          `,
        },
      ),
    ) as Record<PropertyKey, unknown>;

    expect(details).toMatchObject({
      status: "failed",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
    });
    expect(details[CODE_MODE_REPAIR_EVIDENCE]).toBe(true);
    expect(Object.getOwnPropertyDescriptor(details, CODE_MODE_REPAIR_EVIDENCE)).toMatchObject({
      enumerable: false,
      value: true,
    });
    expect(exec.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(details)).not.toContain("codeModeRepairEvidence");
    expect(JSON.stringify(details)).not.toContain("bridgeRequestId");
    expect(JSON.stringify(details)).not.toContain("settlementCapability");
  });

  it("rejects guest settlement attempts without consuming the real pending request", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const target = pluginToolWithExecute("fake_capability_target", "Capability target", async () =>
      jsonResult({ accepted: true }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, target],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-forged-settlement",
        {
          code: `
            const pending = tools.callValue("fake_capability_target", {});
            globalThis.__openclawSettleBridge(
              "guessed-capability",
              "bridge:callValue:1",
              false,
              JSON.stringify("forged rejection"),
            );
            globalThis.__openclawSettleBridge(
              undefined,
              "bridge:callValue:1",
              false,
              JSON.stringify("missing capability"),
            );
            return await pending;
          `,
        },
      ),
    ) as Record<PropertyKey, unknown>;

    expect(target.execute).toHaveBeenCalledOnce();
    expect(details).toMatchObject({ status: "completed", value: { accepted: true } });
    expect(details[CODE_MODE_REPAIR_EVIDENCE]).toBeUndefined();
    expect(JSON.stringify(details)).not.toContain("settlementCapability");
  });

  it("does not authenticate ToolInputError thrown after nested tool execution starts", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const target = pluginToolWithExecute(
      "fake_body_input_error",
      "Throw an execution-phase input error",
      async () => {
        throw new ToolInputError("execution body rejected input");
      },
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, target],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
      toolHookContext: {
        agentId: "main",
        sessionId: "session-code-mode",
        sessionKey: "agent:main:main",
        runId: "run-code-mode",
      },
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-body-input-error",
        {
          code: `return await tools.callValue("fake_body_input_error", {});`,
        },
      ),
    ) as Record<PropertyKey, unknown>;

    expect(target.execute).toHaveBeenCalledOnce();
    expect(details).toMatchObject({
      status: "failed",
      error: expect.stringContaining("execution body rejected input"),
    });
    expect(details[CODE_MODE_REPAIR_EVIDENCE]).toBeUndefined();
  });

  it("does not transfer repair authority through a replacement guest error", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const exec = createExecTool({ security: "full", ask: "off" });
    applyCodeModeCatalog({
      tools: [...codeModeTools, exec],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = resultDetails(
      await expectDefined(codeModeTools[0], "Code Mode exec test invariant").execute(
        "code-call-replaced-preflight",
        {
          code: `
            try {
              await tools.callValue("exec", {
                command: "printf should-not-run",
                host: "sandbox",
              });
            } catch {
              throw new Error("replacement guest failure");
            }
          `,
        },
      ),
    ) as Record<PropertyKey, unknown>;

    expect(details).toMatchObject({
      status: "failed",
      error: expect.stringContaining("replacement guest failure"),
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
    });
    expect(details[CODE_MODE_REPAIR_EVIDENCE]).toBeUndefined();
    expect(JSON.stringify(details)).not.toContain("bridgeRequestId");
  });

  it("fails fast without parking a suspended run when the exec call is aborted", async () => {
    const catalogRef = createToolSearchCatalogRef();
    // Long timeout so a missing abort short-circuit would block the whole test.
    const config = {
      tools: { codeMode: { enabled: true, timeoutMs: 30_000 } },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [
        ...codeModeTools,
        // A tool that never settles and ignores its abort signal; only the
        // host-level abort race can free the cancelled exec.
        pluginToolWithExecute("fake_stuck", "Stuck helper", async () => {
          await new Promise<never>(() => {});
          return null as never;
        }),
      ],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const controller = new AbortController();
    controller.abort();
    const details = resultDetails(
      await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
        "code-call-abort",
        { code: "await tools.fake_stuck({}); return 'done';" },
        controller.signal,
      ),
    );

    // Abort drops the run instead of parking it; a cancelled call must not pin
    // one of the process-global suspended-run slots until TTL expiry.
    expect(details.status).toBe("failed");
    expect(details.error).toBe("code mode execution aborted");
    expect(details.code).toBe("aborted");
    expect(testing.activeRuns.size).toBe(0);
  });

  it("terminates a running guest promptly when the exec call is aborted", async () => {
    const catalogRef = createToolSearchCatalogRef();
    // Long timeout so only the abort race can end the hostile loop quickly.
    const config = {
      tools: { codeMode: { enabled: true, timeoutMs: 30_000 } },
    } as never;
    const ctx = {
      config,
      runtimeConfig: config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    };
    const codeModeTools = createCodeModeTools(ctx);
    applyCodeModeCatalog({
      tools: [...codeModeTools, pluginTool("fake_noop", "Noop")],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 200);
    const startedAt = Date.now();
    try {
      const details = resultDetails(
        await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
          "code-call-abort-live",
          { code: "while (true) {}" },
          controller.signal,
        ),
      );
      expect(details.status).toBe("failed");
      expect(details.error).toBe("code mode execution aborted");
      expect(details.code).toBe("aborted");
    } finally {
      clearTimeout(abortTimer);
    }
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("surfaces policy blocks as guest call errors for declared outputs", async () => {
    const { config, catalogRef, tools: codeModeTools } = createCodeModeHarness();
    const target = pluginTool("fake_policy_block", "Return policy-controlled rows");
    target.outputSchema = Type.Array(
      Type.Object({ id: Type.String() }, { additionalProperties: false }),
    );
    target.execute = vi.fn(async () =>
      buildBlockedToolResult({ reason: "blocked by orchard policy" }),
    );
    applyCodeModeCatalog({
      tools: [...codeModeTools, target],
      config,
      sessionId: "session-code-mode",
      sessionKey: "agent:main:main",
      runId: "run-code-mode",
      catalogRef,
    });

    const details = await runUntilCompleted({
      execTool: expectDefined(codeModeTools[0], "codeModeTools[0] test invariant"),
      waitTool: expectDefined(codeModeTools[1], "codeModeTools[1] test invariant"),
      code: `
        try {
          const rows = await tools.callValue("fake_policy_block", {});
          return rows.map((row) => row.id);
        } catch (error) {
          return error.message;
        }
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toContain("was blocked before execution: blocked by orchard policy");
  });
});
