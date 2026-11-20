import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as codeModeState from "./code-mode-state.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import { resetCodeModeTestState, resultDetails } from "./code-mode.test-support.js";
import { createSandboxTestContext } from "./sandbox/test-fixtures.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { createGitHubPublishTool } from "./tools/github-publish-tool.js";
import * as gateway from "./tools/in-process-gateway.js";

afterEach(async () => {
  await resetCodeModeTestState();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["node", "quickjs"] as const)(
  "%s returns a catchable publication timeout instead of an unbounded bridge wait",
  async (executor) => {
    await import("./session-placement-admission.js");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const harness = createSubscribedCodeModeHarness({ name: "github-deadline", executor });
    const started = createDeferred();
    const release = createDeferred();
    const parked = createDeferred();
    const waitForSettlement = codeModeState.waitForPendingBridgeSettlement;
    vi.spyOn(codeModeState, "waitForPendingBridgeSettlement").mockImplementation((...args) => {
      const waiting = waitForSettlement(...args);
      parked.resolve();
      return waiting;
    });
    // Stall the entire Gateway request, including preparation before handler dispatch.
    const request = vi.spyOn(gateway, "callInProcessGatewayTool").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return { status: "requested", requestId: "synthetic-publication" };
    });
    const target = createGitHubPublishTool({
      sandbox: createSandboxTestContext({ overrides: { workspaceSource: "managed-worktree" } }),
    });
    const surface = applyCodeModeCatalog({
      ...harness,
      tools: [...harness.tools, target],
      toolHookContext: {
        runId: harness.runId,
        watchdogAttempt: harness.replyOperation.watchdog.attachAttempt({ assertCurrent() {} }),
      },
    });
    const exec = expectDefined(
      surface.tools.find((tool) => tool.name === "exec"),
      "exec",
    );
    let result: unknown;
    const execution = withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey: harness.sessionKey },
      () =>
        exec.execute("publish-cell", {
          code: "try { return await github_publish({}); } catch (error) { return error.message; }",
          awaitResults: true,
        }),
    ).then((value) => {
      result = resultDetails(value);
    });
    try {
      await started.promise;
      // Both executors must publish their parked frontier before advancing host deadlines.
      await parked.promise;
      await vi.advanceTimersByTimeAsync(600_001);
      expect(harness.replyOperation.abortSignal.reason).toBeUndefined();
      await vi.waitFor(() =>
        expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" }),
      );
      expect(result).toMatchObject({
        status: "completed",
        value: expect.stringContaining("gateway request timeout for sessions.github.publish"),
      });
      expect(request).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await execution;
      harness.dispose();
    }
  },
);
