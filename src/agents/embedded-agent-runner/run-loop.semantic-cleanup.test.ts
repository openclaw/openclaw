import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSemanticNoProgressObserver } from "../semantic-no-progress.js";
import { runPreparedEmbeddedLoop } from "./run-loop.js";

const fixture = vi.hoisted(() => ({
  observer: undefined as ReturnType<typeof createSemanticNoProgressObserver> | undefined,
  restore: vi.fn(),
  closePermissions: vi.fn(),
  settle: vi.fn(async () => undefined),
  admissionError: new Error("synthetic admission failure"),
}));
vi.mock("../admitted-run-context.js", () => ({
  getAdmittedRunDelegatedAuthority: () => undefined,
  resolveAdmittedRunActiveAssertion: () => () => undefined,
}));
vi.mock("../agent-scope.js", () => ({
  resolveSessionAgentIds: () => ({ sessionAgentId: "main" }),
}));
vi.mock("../execution-contract.js", () => ({
  isStrictAgenticExecutionContractActive: () => false,
}));
vi.mock("./run/preparation-timing.js", () => ({
  measureEmbeddedAgentPreparation: (_name: string, prepare: () => unknown) => prepare(),
}));
vi.mock("./run/runtime-preparation.js", () => ({
  prepareEmbeddedRunRuntime: async () => ({
    admittedRunContext: {},
    provider: "fixture",
    modelId: "fixture",
    model: { id: "fixture" },
    profileCandidates: [],
    attemptedThinking: new Set(),
    snapshot: () => ({ agentHarness: { id: "fixture" }, effectiveModel: { id: "fixture" } }),
  }),
}));
vi.mock("./run/context-recovery-state.js", () => ({
  createEmbeddedRunContextRecoveryState: () => ({
    restoreTimeoutRecoveryAbandonment: fixture.restore,
  }),
}));
vi.mock("./run/tool-outcome-state.js", () => ({
  createRunToolOutcomeState: () => ({ semanticNoProgressObserver: fixture.observer }),
}));
vi.mock("./run/session-prompt-state.js", () => ({
  createEmbeddedRunSessionPromptState: async () => ({ sessionTarget: {} }),
}));
vi.mock("./run/provider-review-run.js", () => ({
  createProviderReviewRun: () => ({
    admit: async () => {
      throw fixture.admissionError;
    },
  }),
}));
vi.mock("./run/permission-change.js", () => ({
  createEmbeddedRunPermissionChanges: () => ({ close: fixture.closePermissions }),
}));
vi.mock("./run/failover-retry-controller.js", () => ({
  createEmbeddedRunFailoverRetryController: () => ({}),
}));
vi.mock("./run/context-engine-admission.js", () => ({
  admitEmbeddedContextEngine: async () => ({}),
}));
vi.mock("./run/run-settlement.js", () => ({ settleEmbeddedRun: fixture.settle }));

it("restores synchronous run state while a cancelled shadow provider is still settling", async () => {
  const dispatched = createDeferred();
  const releaseProvider = createDeferred();
  const closing = createDeferred();
  const observer = createSemanticNoProgressObserver({
    signal: new AbortController().signal,
    assertActive() {},
    runtime: {
      async evaluate() {
        dispatched.resolve();
        await releaseProvider.promise;
        throw new Error("synthetic provider settled");
      },
    },
  });
  fixture.observer = {
    ...observer,
    close() {
      const settled = observer.close();
      closing.resolve();
      return settled;
    },
  };
  const observation = observer.observeOutcome({
    toolName: "synthetic",
    toolParams: {},
    result: "unchanged",
    evidence: { detector: "generic_repeat", level: "warning", count: 10 },
  });
  await dispatched.promise;
  // Only startup collaborators are fixtures; the actual loop finally block and
  // the observer's cancellation/physical-settlement behavior execute unchanged.
  const input = {
    runParams: { prompt: "synthetic", sessionPersistence: "detached" },
    provider: "fixture",
    modelId: "fixture",
    progressController: { notifyExecutionPhase() {} },
    laneController: { abortSignal: new AbortController().signal, throwIfAborted() {} },
    startupStages: { mark() {} },
    onInitialWriterPrepared() {},
  } as unknown as Parameters<typeof runPreparedEmbeddedLoop>[1];
  const result = runPreparedEmbeddedLoop(
    {} as Parameters<typeof runPreparedEmbeddedLoop>[0],
    input,
  ).catch((error: unknown) => error);
  try {
    await closing.promise;
    expect(fixture.restore).toHaveBeenCalledTimes(1);
    expect(fixture.closePermissions).toHaveBeenCalledTimes(1);
    expect(fixture.settle).not.toHaveBeenCalled();
  } finally {
    releaseProvider.resolve();
    await observation;
    expect(await result).toBe(fixture.admissionError);
  }
  expect(fixture.settle).toHaveBeenCalledTimes(1);
});
