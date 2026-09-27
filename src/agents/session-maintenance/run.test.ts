import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { buildEmbeddedRunBaseParams } from "../../auto-reply/reply/agent-runner-run-params.js";
import { createTestFollowupRun } from "../../auto-reply/reply/agent-runner.test-fixtures.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { createSessionMaintenanceFollowup, scheduleSessionMaintenance } from "./run.js";

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: () => {
    throw new Error("Prepared runtime hints must not be rediscovered");
  },
}));

// --- regression: scheduleSessionMaintenance strips foreground caller identity ---

vi.mock("../../gateway/scheduled-run-gateway-context.js", () => ({
  fenceScheduledGatewayContextResolver: (r: unknown) => r,
}));

const mockPluginRegistry = {};
vi.mock("../../plugins/runtime.js", () => ({
  getPluginRegistryForContext: () => mockPluginRegistry,
}));

// Thin pass-through so callers inside the scope still run under the cleared ALS context.
vi.mock("../../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({ resolveGatewayContext: undefined }),
  withPluginRuntimeGatewayRequestScope: (_scope: unknown, fn: () => Promise<unknown>) => fn(),
}));

const workAdmissionFn = vi.fn();
vi.mock("../../process/gateway-work-admission.js", () => ({
  runWithGatewayIndependentRootWorkAdmission: (...args: unknown[]) => workAdmissionFn(...args),
}));

const ownerTrackFn = vi.fn(<T>(p: Promise<T>) => p);

vi.mock("../../sessions/session-lifecycle-admission.js", () => ({
  beginSessionWorkAdmission: ({ assertAllowed }: { assertAllowed?: () => void }) => {
    assertAllowed?.();
    return Promise.resolve({
      run: (fn: () => Promise<unknown>) => fn(),
      release: () => {},
    });
  },
}));

vi.mock("../command/maintenance-budget.js", () => ({
  createCommandBudget: () => ({
    remainingMs: () => 5000,
    dispose: () => {},
    signal: new AbortController().signal,
  }),
}));

const compactionFn = vi.fn();
vi.mock("../command/runtime-loaders.js", () => ({
  loadAgentRunnerMemoryRuntime: () =>
    Promise.resolve({
      runMemoryFlushIfNeeded: () =>
        Promise.resolve({
          sessionEntry: {
            sessionId: "test-session",
            lifecycleRevision: "r1",
            updatedAt: 1,
            pendingFinalDelivery: false,
          },
        }),
      runSessionCompactionIfNeeded: () => compactionFn(),
    }),
  loadSessionStoreRuntime: () =>
    Promise.resolve({
      loadSessionEntryReadOnly: () => ({
        sessionId: "test-session",
        lifecycleRevision: "r1",
        updatedAt: 1,
        pendingFinalDelivery: false,
      }),
    }),
}));

vi.mock("./coordinator.js", () => ({
  createSessionMaintenanceOwner: ({
    abortSignal,
  }: {
    sessionKey: string;
    preemptible: boolean;
    abortSignal: AbortSignal;
  }) => {
    const ctrl = new AbortController();
    abortSignal?.addEventListener("abort", () => ctrl.abort(abortSignal.reason), { once: true });
    return {
      signal: ctrl.signal,
      assertCurrent: () => {},
      run: (fn: () => Promise<unknown>) => fn(),
      track: (p: Promise<unknown>) => ownerTrackFn(p),
    };
  },
}));

vi.mock("../../infra/agent-events.js", () => ({
  assertAgentRunLifecycleGenerationCurrent: () => {},
  registerAgentEventLifecycleRotationHandler: () => {},
}));

afterEach(async () => {
  await drainGlobalSingletonLifecycleState("close");
  vi.clearAllMocks();
});

function makeStaleCallerIdentity() {
  // receiptAuthority returns false as soon as it is checked — simulates a retired turn.
  return {
    agentId: "main",
    sessionKey: "agent:main:test",
    operationalRunInstance: { runId: "foreground-run", instanceId: "foreground-instance" },
    receiptAuthority: () => false as boolean,
  };
}

function makeMaintenanceRequest(followupRun: ReturnType<typeof createTestFollowupRun>) {
  const sessionEntry = {
    sessionId: "test-session",
    lifecycleRevision: "r1",
    updatedAt: 1,
    pendingFinalDelivery: false,
  };
  return {
    prepared: {
      cfg: followupRun.run.config,
      sessionKey: "agent:main:test",
      storePath: "/tmp/test-store",
      timeoutMs: 30000,
    },
    followupRun,
    sessionId: "test-session",
    lifecycleRevision: "r1" as string & {},
    lifecycleGeneration: "gen-1",
    startedAt: Date.now(),
  };
}

it("strips foreground caller identity so process-owned maintenance has no stale caller", async () => {
  const callerSeenAtAdmission = createDeferred<ReturnType<typeof getGatewayToolCallerIdentity>>();
  workAdmissionFn.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
    callerSeenAtAdmission.resolve(getGatewayToolCallerIdentity());
    return fn();
  });
  compactionFn.mockResolvedValueOnce(undefined);

  const foreground = createTestFollowupRun({ provider: "test-provider", model: "test-model" });
  const request = makeMaintenanceRequest(foreground);

  const staleIdentity = makeStaleCallerIdentity();
  await withGatewayToolCallerIdentity(staleIdentity, async () => {
    // Confirm the stale identity is active in this scope.
    expect(captureGatewayToolCallerAssertion()).toBeDefined();
    expect(() => captureGatewayToolCallerAssertion()?.()).toThrow(
      "agent tool caller authority is no longer active",
    );

    // Schedule maintenance from inside the stale foreground caller context.
    scheduleSessionMaintenance(request);
  });

  // Inside the maintenance work, the stale foreground identity must be absent.
  const seen = await callerSeenAtAdmission.promise;
  expect(seen).toBeUndefined();

  // Await full settlement so no promise leaks into subsequent tests.
  await ownerTrackFn.mock.results.at(-1)!.value.catch(() => {});
});

it("stale foreground caller does not cause captureGatewayToolCallerAssertion to throw during maintenance", async () => {
  const assertionAtCompaction = createDeferred<(() => void) | undefined>();
  workAdmissionFn.mockImplementationOnce(async (fn: () => Promise<unknown>) => fn());
  compactionFn.mockImplementationOnce(async () => {
    // This is what the compaction path calls at tool-setup time.
    assertionAtCompaction.resolve(captureGatewayToolCallerAssertion());
  });

  const foreground = createTestFollowupRun({ provider: "test-provider", model: "test-model" });
  const request = makeMaintenanceRequest(foreground);

  await withGatewayToolCallerIdentity(makeStaleCallerIdentity(), async () => {
    scheduleSessionMaintenance(request);
  });

  // Compaction ran and captured the assertion result.
  const assertion = await assertionAtCompaction.promise;
  // No stale authority — no assertion function captured; won't throw.
  expect(assertion).toBeUndefined();

  // Await full settlement so no promise leaks into subsequent tests.
  await ownerTrackFn.mock.results.at(-1)!.value.catch(() => {});
});

it("maintenance skips all work when foreground owner did not complete successfully", async () => {
  const foreground = createTestFollowupRun({ provider: "test-provider", model: "test-model" });
  const request = makeMaintenanceRequest(foreground);

  // afterOwnerSettles = Promise.resolve(false) → the foreground owner failed/aborted;
  // scheduleSessionMaintenance returns early before owner.run() so no work runs.
  scheduleSessionMaintenance(request, Promise.resolve(false));

  await ownerTrackFn.mock.results.at(-1)!.value.catch(() => {});
  expect(workAdmissionFn).not.toHaveBeenCalled();
  expect(compactionFn).not.toHaveBeenCalled();
});

it("preserves prepared model facts and restrictive policy without foreground authority", async () => {
  const foreground = createTestFollowupRun({
    provider: "test-provider",
    model: "test-model",
    thinkingCatalog: [{ provider: "test-provider", id: "test-model", input: ["text", "image"] }],
    senderIsOwner: true,
    conversationToolPolicy: { deny: ["read"] },
    toolOverrides: { webSearch: false },
  });
  const maintenance = createSessionMaintenanceFollowup({
    run: foreground.run,
    sessionEntry: { sessionId: "maintenance", updatedAt: 1 },
    sessionKey: "agent:main:maintenance",
    cfg: foreground.run.config,
    provider: "test-provider",
    model: "test-model",
    auth: {},
  });
  const embedded = await buildEmbeddedRunBaseParams({
    run: maintenance.run,
    provider: "test-provider",
    model: "test-model",
    runId: "maintenance-run",
    authProfile: {},
  });
  expect(embedded.modelHasVision).toBe(true);
  expect(embedded.conversationToolPolicy).toEqual({ deny: ["read"] });
  expect(embedded.senderIsOwner).toBe(false);
  expect(embedded.toolOverrides).toBeUndefined();
  expect(embedded.runtimePluginToolGrant).toBeUndefined();
  expect(maintenance.userTurnTranscriptRecorder).toBeUndefined();
});
