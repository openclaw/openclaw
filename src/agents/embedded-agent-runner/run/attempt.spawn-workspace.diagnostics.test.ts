// Coverage for trusted diagnostics emitted by a full embedded attempt.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPrivateData,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { AgentRunTerminalOutcomeError } from "../../agent-run-terminal-error.js";
import type { createOpenClawCodingTools } from "../../agent-tools.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

describe("runEmbeddedAttempt diagnostics", () => {
  const tempPaths: string[] = [];

  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    resetDiagnosticEventsForTest();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempPaths(tempPaths);
    resetDiagnosticEventsForTest();
  });

  it("attributes awaited bundle work separately from synchronous catalog preparation", async () => {
    const bundleLspTools = await import("../../agent-bundle-lsp-runtime.js");
    const runtimeToolPolicy = await import("../../runtime-plan/tools.js");
    const { log } = await import("../logger.js");
    let clock = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const warn = vi.spyOn(log, "warn");
    const acquired = createDeferred();
    const release = createDeferred();
    const dispose = vi.fn(async () => {});
    vi.spyOn(bundleLspTools, "createBundleLspToolRuntime").mockImplementationOnce(async () => {
      acquired.resolve();
      await release.promise;
      return { tools: [], sessions: [], dispose };
    });
    vi.spyOn(runtimeToolPolicy, "logAgentRuntimeToolDiagnostics").mockImplementation(() => {
      clock += 37;
    });
    getHoisted().createOpenClawCodingToolsMock.mockReturnValue([createStubTool("read")]);
    const attempt = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:bundle-timing",
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        config: { tools: { codeMode: true } },
      },
    });
    try {
      await Promise.race([
        acquired.promise,
        attempt.then(() => {
          throw new Error("Attempt completed before bundle acquisition");
        }),
      ]);
      clock += 6_000;
      release.resolve();
      const result = await attempt;
      expect(result.terminal).toEqual({ kind: "ok" });
      expect(dispose).toHaveBeenCalledOnce();
      const summary = warn.mock.calls
        .map(([message]) => message)
        .find(
          (message) => message.includes("prep stages:") && message.includes("phase=stream-ready"),
        );
      expect(summary).toContain("bundle-tools:6000ms@");
      expect(summary).toContain("tool-catalog:37ms@");
      expect(summary).toContain("tool-preparation:6037ms@");
      expect(summary).toContain("system-prompt:0ms@");
    } finally {
      release.resolve();
      await attempt;
    }
  });

  it.each([
    { kind: "cancel", errorName: "AbortError" },
    { kind: "timeout", errorName: "TimeoutError" },
  ] as const)(
    "classifies $kind during pending LSP acquisition through the full attempt",
    async ({ kind, errorName }) => {
      const bundleLspTools = await import("../../agent-bundle-lsp-runtime.js");
      const acquired = createDeferred();
      const acquisition = createDeferred<never>();
      void acquisition.promise.catch(() => {});
      const controller = new AbortController();
      const reason = new Error(`LSP preparation ${kind}`);
      reason.name = errorName;
      const createLsp = vi
        .spyOn(bundleLspTools, "createBundleLspToolRuntime")
        .mockImplementationOnce(({ abortSignal }) => {
          const onAbort = () => acquisition.reject(abortSignal?.reason);
          abortSignal?.addEventListener("abort", onAbort, { once: true });
          if (abortSignal?.aborted) {
            onAbort();
          }
          acquired.resolve();
          return acquisition.promise.finally(() =>
            abortSignal?.removeEventListener("abort", onAbort),
          );
        });
      const cleanup = vi.fn(async (_reason: string) => {});
      const hoisted = getHoisted();
      hoisted.createOpenClawCodingToolsMock.mockImplementation((options: unknown) => {
        const toolOptions = options as NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;
        toolOptions.registerRunCleanup?.(cleanup);
        return [createStubTool("read")];
      });
      const runId = `run-lsp-acquisition-${kind}`;
      const completed: Array<{
        event: DiagnosticEventPayload;
        privateData: DiagnosticEventPrivateData;
      }> = [];
      const unsubscribe = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
        if (event.type === "run.completed" && event.runId === runId) {
          completed.push({ event, privateData });
        }
      });
      const attempt = createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: `agent:main:lsp-acquisition-${kind}`,
        tempPaths,
        attemptOverrides: { runId, abortSignal: controller.signal, disableTools: false },
      });
      const outcome = attempt.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await Promise.race([
          acquired.promise,
          outcome.then(() => {
            throw new Error("Attempt completed before LSP acquisition");
          }),
        ]);
        controller.abort(reason);
        await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce(), { timeout: 1_000 });
        expect(cleanup).toHaveBeenCalledExactlyOnceWith(kind);
        const error = await outcome;
        if (kind === "timeout") {
          if (!(error instanceof AgentRunTerminalOutcomeError)) {
            throw new Error("Expected the canonical timeout outcome", { cause: error });
          }
          expect(error.cause).toBe(reason);
          expect(error.terminalOutcome).toMatchObject({ status: "timeout" });
        } else {
          expect(error).toBe(reason);
        }
        expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();
        await waitForDiagnosticEventsDrained();
        expect(completed).toHaveLength(1);
        expect(completed[0]?.event).toMatchObject({
          type: "run.completed",
          runId,
          outcome: "aborted",
          errorCategory: "Error",
        });
        expect(completed[0]?.event).not.toHaveProperty("error");
        expect(completed[0]?.privateData.errorMessage).toBe(reason.message);
      } finally {
        // Missing signal forwarding must fail without stranding the attempt's owners.
        acquisition.reject(reason);
        try {
          await outcome;
          await waitForDiagnosticEventsDrained();
        } finally {
          unsubscribe();
          createLsp.mockRestore();
        }
      }
    },
  );

  it("keeps run failure text on the trusted private channel", async () => {
    const completed: Array<{
      event: DiagnosticEventPayload;
      privateData: DiagnosticEventPrivateData;
    }> = [];
    const unsubscribe = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "run.completed") {
        completed.push({ event, privateData });
      }
    });

    try {
      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:diagnostic-failure",
        tempPaths,
        sessionPrompt: async () => {
          throw new Error("provider stream failed");
        },
      });
      await waitForDiagnosticEventsDrained();
    } finally {
      unsubscribe();
    }

    expect(completed).toHaveLength(1);
    expect(completed[0]?.event).toMatchObject({
      type: "run.completed",
      outcome: "error",
      errorCategory: "Error",
    });
    expect(completed[0]?.event).not.toHaveProperty("error");
    expect(completed[0]?.privateData.errorMessage).toBe("provider stream failed");
  });
});
