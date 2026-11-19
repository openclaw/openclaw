import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawPluginToolContext } from "../plugins/types.js";
import { SESSION_WATCHDOG_QUIET_TOOL_MS } from "../sessions/session-controller.watchdog-state.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import { resetCodeModeTestState } from "./code-mode.test-support.js";
import { DEFAULT_AGENT_TIMEOUT_MS } from "./timeout.js";
import type { AnyAgentTool } from "./tools/common.js";

const disposers: Array<() => void> = [];
function createHarness(params: Parameters<typeof createSubscribedCodeModeHarness>[0]) {
  const harness = createSubscribedCodeModeHarness(params);
  disposers.push(harness.dispose);
  return harness;
}

describe("Auto Review parent execution allowance", () => {
  afterEach(async () => {
    disposers.splice(0).forEach((dispose) => dispose());
    vi.useRealTimers();
    await resetCodeModeTestState();
    clearRuntimeConfigSnapshot();
  });
  it.each(["finite", "unlimited"] as const)(
    "keeps quiet nested Auto Review alive within its %s parent allowance, then reaps a hang",
    async (parent) => {
      await import("./session-placement-admission.js");
      const { createAutoReviewTool } = await loadBundledPluginFacade<{
        createAutoReviewTool: (context: OpenClawPluginToolContext<2>) => AnyAgentTool | null;
      }>({ pluginId: "autoreview", artifactBasename: "api.js" });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(10);
      const harness = createHarness({ name: `review-${parent}`, timeoutMs: 2_000 });
      const operation = harness.replyOperation;
      operation.setPhase("running");
      const cancel = vi.fn(() => {
        harness.runAbortController.abort();
        operation.complete();
      });
      operation.attachBackend({ kind: "embedded", runId: harness.runId, cancel });
      const watchdogAttempt = operation.watchdog.attachAttempt({ assertCurrent() {} });
      const bound = parent === "finite" ? 1_800_000 : Date.now() + DEFAULT_AGENT_TIMEOUT_MS;
      const started = createDeferred();
      const review = expectDefined(
        createAutoReviewTool({
          assertInvocationCurrent() {},
          assertCompleteResult() {},
          modelExecution: {
            cliEntryPath: "/fixture/openclaw.mjs",
            async run() {
              throw new Error("The stalled helper must not start a reviewer");
            },
          },
          sandbox: {
            workspaceDir: "/guest/repo",
            installedSkillRoots: { autoreview: "/protected/autoreview" },
            run: async ({ signal }) => {
              started.resolve();
              return await new Promise<never>((_, reject) => {
                signal?.addEventListener(
                  "abort",
                  () => reject(new DOMException("Cancelled", "AbortError")),
                  { once: true },
                );
              });
            },
          },
        }),
        "Auto Review",
      );
      const toolHookContext = {
        runId: harness.runId,
        sessionKey: harness.sessionKey,
        watchdogAttempt,
        getRunAbortDeadlineAtMs: () => (parent === "finite" ? bound : undefined),
      };
      const surface = applyCodeModeCatalog({
        ...harness,
        tools: [...harness.tools, wrapToolWithBeforeToolCallHook(review, toolHookContext)],
        toolHookContext,
      });
      const exec = expectDefined(
        surface.tools.find((entry) => entry.name === "exec"),
        "exec",
      );
      const execution = wrapToolWithBeforeToolCallHook(exec, { watchdogAttempt }).execute(
        "review-cell",
        { code: "return await autoreview({ mode: 'local' });", awaitResults: true },
        harness.runAbortController.signal,
      );
      // Observe cancellation immediately, including the pre-fix watchdog abort.
      const settled = execution.catch((error: unknown) => error);
      try {
        await started.promise;
        // Drive the owning watchdog boundary independently of bridge timers.
        vi.setSystemTime(Date.now() + SESSION_WATCHDOG_QUIET_TOOL_MS + 1);
        await operation.watchdog.tick(Date.now());
        await vi.waitFor(() =>
          expect(operation.watchdog.snapshot().recovery?.status).not.toBe("pending"),
        );
        expect(operation.abortSignal.reason).toBeUndefined();
        expect(cancel).not.toHaveBeenCalled();
        expect(new Set(operation.watchdog.snapshot().tools.map((entry) => entry.toolName))).toEqual(
          new Set(["autoreview", "exec"]),
        );
        vi.setSystemTime(bound + SESSION_WATCHDOG_QUIET_TOOL_MS - 1);
        expect(await operation.watchdog.tick(Date.now())).toEqual({
          action: "warn",
          reason: "no_semantic_progress",
          deadlineAtMs: bound + SESSION_WATCHDOG_QUIET_TOOL_MS,
        });
        expect(operation.abortSignal.reason).toBeUndefined();
        expect(cancel).not.toHaveBeenCalled();
        vi.setSystemTime(bound + SESSION_WATCHDOG_QUIET_TOOL_MS + 1);
        await operation.watchdog.tick(Date.now());
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        expect(operation.abortSignal.reason).toMatchObject({
          name: "AbortError",
          code: "OPENCLAW_SESSION_WATCHDOG",
          message: "Reply operation stalled",
        });
        expect(operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
        await settled;
      } finally {
        harness.runAbortController.abort();
        await settled;
      }
    },
  );
});
