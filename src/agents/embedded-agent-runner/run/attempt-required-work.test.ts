import { afterEach, expect, it, vi } from "vitest";
import type { RunExit, SpawnInput } from "../../../process/supervisor/types.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resetProcessRegistryForTests } from "../../bash-process-registry.test-support.js";
import { createExecTool } from "../../bash-tools.exec-run.js";
import * as codeModeState from "../../code-mode-state.js";
import { applyCodeModeCatalog } from "../../code-mode.js";
import { createCodeModeHarness, resetCodeModeTestState } from "../../code-mode.test-support.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { clearActiveEmbeddedRun } from "../runs.js";
import { prepareCatalogExecutor } from "./attempt-stream-prepare.test-support.js";

const processOwner = vi.hoisted(() => ({
  wait: vi.fn<() => Promise<RunExit>>(),
  output: undefined as SpawnInput["onStdout"],
}));
vi.mock("../../../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: async (input: SpawnInput) => {
      processOwner.output = input.onStdout;
      return {
        runId: "required-command",
        startedAtMs: Date.now(),
        activity: { resultSettled: false, lastOutputAtMs: Date.now() },
        wait: processOwner.wait,
        cancel: vi.fn(),
      };
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
  }),
}));
vi.mock("../../../infra/shell-env.js", () => ({
  getShellPathFromLoginShell: vi.fn(() => null),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
  shouldEnableShellEnvFallback: vi.fn(() => false),
  shouldDeferShellEnvFallback: vi.fn(() => false),
}));
vi.mock("../../bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: vi.fn(async () => ({})),
}));

registerAgentSessionLoopTestLifecycle();
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await resetCodeModeTestState();
  resetProcessRegistryForTests();
});

it.each(["direct", "cell", "nested", "detached"] as const)(
  "keeps required results owned through real finalization (%s)",
  async (mode) => {
    const required = mode !== "detached";
    const nested = mode !== "direct";
    const completed = createDeferredCore<RunExit>();
    const spawned = createDeferredCore();
    const parked = createDeferredCore();
    processOwner.wait.mockReset().mockImplementation(() => {
      spawned.resolve();
      return completed.promise;
    });
    const waitForSettlement = codeModeState.waitForPendingBridgeSettlement;
    vi.spyOn(codeModeState, "waitForPendingBridgeSettlement").mockImplementation((...args) => {
      parked.resolve();
      return waitForSettlement(...args);
    });
    const shell = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      notifyOnExit: false,
      allowBackground: true,
      scopeKey: "agent:main:main",
      sessionKey: "agent:main:main",
    });
    const h = createCodeModeHarness();
    if (nested) {
      applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, shell] });
    }
    const { session } = await createTestSession({ customTools: nested ? h.tools : [shell] });
    const prepared = prepareCatalogExecutor([], { activeSession: session });
    const finalRequested = createDeferredCore();
    let requests = 0;
    let finished = false;
    const command = {
      command: "verify-result",
      ...(mode === "detached" ? { background: true } : mode === "cell" ? {} : { required: true }),
    };
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests++;
      if (requests === 1) {
        return createAssistantResultStream(
          createAssistant(
            model,
            [
              {
                type: "toolCall",
                id: "start-command",
                name: "exec",
                arguments: nested
                  ? {
                      code: `return await exec(${JSON.stringify(command)});`,
                      required: mode !== "nested",
                      title: "Collect required verification",
                    }
                  : command,
              },
            ],
            "toolUse",
          ),
        );
      }
      finalRequested.resolve();
      if (required) {
        expect(JSON.stringify(context.messages)).toContain("REQUIRED_RESULT");
      }
      return createAssistantResultStream(
        createAssistant(model, [
          { type: "text", text: required ? "Result collected." : "Server started." },
        ]),
      );
    });
    const running = session.prompt("Run verification and report its result.").then(() => {
      finished = true;
    });
    const finish = () => {
      processOwner.output?.("REQUIRED_RESULT");
      completed.resolve({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        stdout: "REQUIRED_RESULT",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    };
    try {
      await spawned.promise;
      if (nested && required) {
        await parked.promise;
      }
      if (!required) {
        await finalRequested.promise;
      }
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toBe(required ? 1 : 2);
      expect(finished).toBe(!required);
      expect(codeModeState.activeRuns.size).toBe(0);
      vi.useRealTimers();
      finish();
      await running;
      await prepared.subscription.waitForPendingEvents();
      expect(requests).toBe(2);
      expect(processOwner.wait).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      finish();
      await running;
      prepared.subscription.unsubscribe();
      clearActiveEmbeddedRun("session-output-schema", prepared.queueHandle, "agent:main:main");
    }
  },
);
