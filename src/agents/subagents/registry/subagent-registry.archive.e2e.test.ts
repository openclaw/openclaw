import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import { ensureContextEnginesInitialized } from "../../../context-engine/init.js";
import { resolveContextEngine } from "../../../context-engine/registry.js";
import { callGateway } from "../../../gateway/call.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import {
  captureSubagentCompletionReply,
  runSubagentAnnounceFlow,
} from "../announce/subagent-announce.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { subscribeSubagentRunChanges } from "./subagent-registry-publication.js";
import { registerArchiveCancellationTests } from "./subagent-registry.archive-cancellation.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";

const sessionAccessorMocks = vi.hoisted(() => ({
  readSessionEntryReadOnlyInWorker: vi.fn<
    typeof import("../../../config/sessions/session-entry-read-runtime.js").readSessionEntryReadOnlyInWorker
  >(async () => undefined),
}));

const noop = () => {};
let currentConfig = {
  agents: { defaults: { subagents: { archiveAfterMinutes: 60 } } },
};
const loadConfigMock = vi.mocked(getRuntimeConfig);

const respondToGatewayRequest = vi.hoisted(
  () => async (request: { method?: string }) =>
    request.method === "agent.wait" ? { status: "pending" } : {},
);

vi.mock("../../../gateway/call.js", () => ({
  callGateway: vi.fn(respondToGatewayRequest),
}));

vi.mock("../../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../config/sessions/session-entry-read-runtime.js")>();
  return {
    ...actual,
    readSessionEntryReadOnlyInWorker: async (
      ...args: Parameters<typeof actual.readSessionEntryReadOnlyInWorker>
    ) => {
      const [, assertCurrent] = args;
      assertCurrent?.();
      const entry = await sessionAccessorMocks.readSessionEntryReadOnlyInWorker(...args);
      assertCurrent?.();
      return entry;
    },
  };
});

vi.mock("../../../infra/agent-events.js", () => ({
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  onAgentEvent: vi.fn((_handler: unknown) => noop),
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));
vi.mock("../../../infra/agent-run-registry.js", () => ({
  getAgentRunContext: vi.fn(() => undefined),
  hasLiveAgentRunContext: vi.fn(() => false),
}));

vi.mock("../../../config/config.js", { spy: true });
vi.mock("../../../context-engine/init.js", { spy: true });
vi.mock("../../../context-engine/registry.js", { spy: true });

vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn<
    typeof import("../../../browser-lifecycle-cleanup.js").cleanupBrowserSessionsForLifecycleEnd
  >(async () => {}),
}));

vi.mock("../../runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../../../plugins/registry-empty.js");
  return {
    loadAgentRuntimePluginRegistryHandle: vi.fn<
      typeof import("../../runtime-plugins.js").loadAgentRuntimePluginRegistryHandle
    >(() => createEmptyPluginRegistry()),
  };
});

vi.mock("../announce/subagent-announce.js", () => ({
  captureSubagentCompletionReply: vi.fn<
    typeof import("../announce/subagent-announce.js").captureSubagentCompletionReply
  >(async () => undefined),
  runSubagentAnnounceFlow: vi.fn<
    typeof import("../announce/subagent-announce.js").runSubagentAnnounceFlow
  >(async () => "delivered"),
}));

vi.mock("../announce/subagent-announce.requester-settle-wake.js", () => ({
  maybeWakeRequesterAfterAllChildrenSettled: vi.fn<
    typeof import("../announce/subagent-announce.requester-settle-wake.js").maybeWakeRequesterAfterAllChildrenSettled
  >(async (params) => {
    await params.completeBatch([params.settledEntry]);
    return false;
  }),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

let settleRootWork: ReturnType<typeof observeRootWork>;
let mod: typeof import("./subagent-registry.test-helpers.js");

beforeAll(async () => {
  mod = await import("./subagent-registry.test-helpers.js");
});

type RunInput = Parameters<typeof mod.addSubagentRunForTests>[0];
const addCanonicalSubagentRunForTests = (
  entry: Required<Pick<RunInput, "runId" | "childSessionKey" | "task">> & Partial<RunInput>,
) => {
  const suffix = entry.childSessionKey.replace("agent:main:subagent:", "");
  return mod.addSubagentRunForTests({
    childSessionIdentity: {
      sessionId: `session-${suffix}`,
      lifecycleRevision: `lifecycle-${suffix}`,
    },
    ...entry,
  });
};
const deleteCalls = () =>
  vi.mocked(callGateway).mock.calls.filter(([request]) => request.method === "sessions.delete");
const setArchiveMinutes = (archiveAfterMinutes: number) => {
  currentConfig = { agents: { defaults: { subagents: { archiveAfterMinutes } } } };
  setRuntimeConfigSnapshot(currentConfig);
};

const addRun = (suffix: string, overrides: Partial<RunInput> = {}) =>
  addCanonicalSubagentRunForTests({
    runId: `run-${suffix}`,
    childSessionKey: `agent:main:subagent:${suffix}`,
    task: suffix,
    cleanup: "delete",
    ...overrides,
  });
const prepareDelete = (suffix: string, onDelete: () => void | Promise<void>) => {
  setArchiveMinutes(1);
  sessionAccessorMocks.readSessionEntryReadOnlyInWorker.mockResolvedValue({
    sessionId: `session-${suffix}`,
    lifecycleRevision: `lifecycle-${suffix}`,
    updatedAt: Date.now(),
  });
  vi.mocked(callGateway).mockImplementation(async (request) => {
    if (request.method === "sessions.delete") {
      await onDelete();
    }
    return respondToGatewayRequest(request);
  });
};
const expectDelete = (suffix: string) =>
  expect(callGateway).toHaveBeenCalledWith({
    assertDispatchCurrent: expect.any(Function),
    method: "sessions.delete",
    timeoutMs: 10_000,
    params: {
      key: `agent:main:subagent:${suffix}`,
      agentId: "main",
      deleteTranscript: true,
      emitLifecycleHooks: false,
      expectedSessionId: `session-${suffix}`,
      expectedLifecycleRevision: `lifecycle-${suffix}`,
    },
  });
const requesterRuns = () => mod.listSubagentRunsForRequester("agent:main:main");

const sweepAndSettleCleanup = async () => {
  try {
    await mod.testing.sweepOnceForTests();
  } finally {
    // Sweeping admits detached cleanup and requester-settlement work. Join
    // those real promises; a fixed number of microtasks cannot prove retirement.
    await settleRootWork(true);
  }
};

const waitForNoRequesterRuns = () => vi.waitFor(() => expect(requesterRuns()).toHaveLength(0));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  setArchiveMinutes(60);
  vi.mocked(callGateway).mockReset().mockImplementation(respondToGatewayRequest);
  loadConfigMock.mockReset().mockImplementation(() => currentConfig);
  vi.mocked(ensureContextEnginesInitialized).mockReset();
  vi.mocked(resolveContextEngine).mockReset();
  vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
  vi.mocked(captureSubagentCompletionReply).mockReset();
  vi.mocked(runSubagentAnnounceFlow).mockReset();
  vi.mocked(getAgentRunContext).mockReset().mockReturnValue(undefined);
  sessionAccessorMocks.readSessionEntryReadOnlyInWorker.mockReset();
  await mod.resetSubagentRegistryForTests({ persist: false });
  settleRootWork = observeRootWork();
});

afterEach(async () => {
  try {
    await settleRootWork();
  } finally {
    await mod.resetSubagentRegistryForTests({ persist: false });
    vi.useRealTimers();
    clearRuntimeConfigSnapshot();
  }
});

it("starts delete-mode retention when its terminal lifecycle event completes", async () => {
  setArchiveMinutes(1);
  vi.mocked(getAgentRunContext).mockReturnValue({} as never);
  vi.mocked(captureSubagentCompletionReply).mockResolvedValue("completed result");
  vi.mocked(runSubagentAnnounceFlow).mockResolvedValue("retryable");

  await mod.registerSubagentRun(
    createSubagentRunParams({
      runId: "run-delete-completed",
      childSessionKey: "agent:main:subagent:delete-completed",
      sessionEntry: {
        sessionId: "session-delete-completed",
        lifecycleRevision: "lifecycle-delete-completed",
      },
      task: "finish after a long run",
      cleanup: "delete",
      expectsCompletionMessage: true,
    }),
  );
  await vi.advanceTimersByTimeAsync(90_000);

  const endedAt = Date.now();
  const lifecycleHandler = vi.mocked(onAgentEvent).mock.calls.at(-1)?.[0];
  expect(lifecycleHandler).toBeTypeOf("function");
  const terminalPublished = createDeferred();
  const stop = subscribeSubagentRunChanges("projection", () => {
    const run = subagentRuns.get("run-delete-completed");
    if (run?.execution.status === "terminal" && run.execution.endedAt === endedAt) {
      terminalPublished.resolve();
    }
  });
  try {
    lifecycleHandler?.({
      runId: "run-delete-completed",
      stream: "lifecycle",
      seq: 1,
      ts: endedAt,
      data: { phase: "end", endedAt, terminalReply: { disposition: "visible", text: "done" } },
    });
    await terminalPublished.promise;
  } finally {
    stop();
  }

  await settleRootWork(true);
  expect(requesterRuns()[0]).toMatchObject({
    execution: { status: "terminal", endedAt },
    archiveAtMs: endedAt + 60_000,
  });
});

it.each(["queued", "running"] as const)("keeps %s runs past the stale grace", async (status) => {
  const queued = status === "queued";
  const suffix = queued ? "queued-collector" : "delete-stale-deadline";
  const createdAt = Date.now() - 120_000;
  if (!queued) {
    vi.mocked(getAgentRunContext).mockReturnValue({} as never);
  }
  await addRun(
    suffix,
    queued
      ? { createdAt, cleanup: "keep", collect: true, execution: { status: "queued" } }
      : { createdAt, startedAt: createdAt, archiveAtMs: Date.now() - 60_000 },
  );
  await mod.testing.sweepOnceForTests();
  const run = requesterRuns()[0];
  expect(run).toMatchObject({ runId: `run-${suffix}`, execution: { status } });
  if (queued) {
    expect(run?.collectorCompletion).toBeUndefined();
  } else {
    expect(deleteCalls()).toHaveLength(0);
  }
});

it("keeps pending delivery until completion before archival", async () => {
  const deliveryStatus = "pending";
  const now = Date.now();
  await addRun(`delete-delivery-${deliveryStatus}`, {
    expectsCompletionMessage: true,
    createdAt: now - 120_000,
    endedAt: now - 60_000,
    archiveAtMs: now - 1,
    delivery: { status: deliveryStatus },
  });

  await mod.testing.sweepOnceForTests();

  const entry = requesterRuns()[0];
  expect(entry?.delivery?.status).toBe(deliveryStatus);
  expect(deleteCalls()).toHaveLength(0);

  await mutateSubagentRuns([entry!.runId], (rows) => {
    const current = rows.get(entry!.runId)!;
    const next = { ...current, delivery: { ...current.delivery, status: "delivered" as const } };
    return { value: undefined, postimages: new Map([[current.runId, next]]) };
  });
  await mod.testing.sweepOnceForTests();

  await waitForNoRequesterRuns();
});

it("keeps archived delete-mode runs for retry when sessions.delete fails", async () => {
  const onSubagentEnded = vi.fn(async () => undefined);
  const attachmentsRootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sweep-retry-"));
  const attachmentsDir = path.join(attachmentsRootDir, "child");
  await fs.mkdir(attachmentsDir, { recursive: true });
  await fs.writeFile(path.join(attachmentsDir, "artifact.txt"), "artifact", "utf8");
  let deleteAttempts = 0;
  prepareDelete("delete-retry", () => {
    if (++deleteAttempts === 1) {
      throw new Error("delete failed");
    }
  });
  vi.mocked(ensureContextEnginesInitialized).mockResolvedValue(undefined);
  vi.mocked(resolveContextEngine).mockResolvedValue({
    info: { id: "test", name: "Test", version: "0.0.1" },
    ingest: async () => ({ ingested: false }),
    assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
    compact: async () => ({ ok: false, compacted: false }),
    onSubagentEnded,
  });

  await addRun("delete-retry", {
    createdAt: Date.now() - 60_000,
    endedAt: Date.now() - 1,
    archiveAtMs: Date.now(),
    attachmentsDir,
    attachmentsRootDir,
  });

  await mod.testing.sweepOnceForTests();
  await vi.dynamicImportSettled();

  expect(deleteAttempts).toBe(1);
  expectDelete("delete-retry");
  expect(requesterRuns()).toHaveLength(1);
  expect(onSubagentEnded).not.toHaveBeenCalled();
  await fs.access(attachmentsDir);

  await mod.testing.sweepOnceForTests();
  await vi.dynamicImportSettled();

  expect(deleteAttempts).toBe(2);
  expect(requesterRuns()).toHaveLength(0);
});

registerArchiveCancellationTests({
  getRegistry: () => mod,
  addCanonicalSubagentRunForTests,
  sweepAndSettleCleanup,
  waitForNoRequesterRuns,
});

it("does not overlap archive sweep retries while sessions.delete is still in flight", async () => {
  const deleteGate = createDeferred();
  const deleteEntered = createDeferred();
  prepareDelete("delete-inflight", async () => {
    deleteEntered.resolve();
    await deleteGate.promise;
  });

  await addRun("delete-inflight", {
    createdAt: Date.now() - 60_000,
    endedAt: Date.now() - 1,
    archiveAtMs: Date.now(),
  });

  const firstSweep = mod.testing.sweepOnceForTests();
  try {
    await deleteEntered.promise;
    expect(deleteCalls()).toHaveLength(1);
    expectDelete("delete-inflight");

    await mod.testing.sweepOnceForTests();
    expect(deleteCalls()).toHaveLength(1);
    expect(requesterRuns()).toHaveLength(1);
  } finally {
    deleteGate.resolve();
    await firstSweep;
  }
  await vi.dynamicImportSettled();
  await waitForNoRequesterRuns();
});
