import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { HarnessCompletionRecovery } from "../../../config/sessions/restart-recovery-types.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import * as sessionEntryWriter from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { useTempSessionsFixture } from "../../../config/sessions/test-helpers.js";
import { SessionTranscriptWriterClaimReboundError } from "../../../config/sessions/transcript-write-context.js";
import { appendExactAssistantMessageToSessionTranscript } from "../../../config/sessions/transcript.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  resetAgentEventsForTest,
} from "../../../infra/agent-events.js";
import { registerAgentRunContext } from "../../../infra/agent-run-registry.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { createHarnessCompletionSourceAssertion } from "../../agent-harness-completion-recovery.js";
import {
  buildAgentRunTerminalOutcomeFromLifecycleEvent,
  type AgentRunTerminalOutcome,
} from "../../agent-run-terminal-outcome.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../../stream-message-shared.js";
import { log } from "../logger.js";
import { setActiveEmbeddedRun } from "../runs.js";
import { testing as runsTesting } from "../runs.test-support.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import { createLaneControllerFixture } from "./lane-controller.test-support.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import { claimAgentSessionWriter } from "./session-bootstrap.js";

const fixture = useTempSessionsFixture("lane-writer-claim-");
const sessionId = "writer-session";
const sessionKey = "agent:main:writer-session";
const lifecycleRevision = "writer-revision";
const sessionRevision = { lifecycleRevision, sessionId };

const completedResult: EmbeddedAgentRunResult = { meta: { durationMs: 0 } };

const scope = () => ({ agentId: "main", sessionKey, storePath: fixture.storePath() });
const readEntry = () => loadSessionEntry(scope());
const assistantMessage = (text: string) =>
  buildAssistantMessage({
    model: { api: "openai-responses", provider: "openai", id: "gpt-test" },
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: buildUsageWithNoCost({}),
  });

function writerParams(overrides: Partial<RunEmbeddedAgentParams> = {}) {
  return {
    ...scope(),
    prompt: "hello",
    runId: "run-b",
    sessionFile: sessionKey,
    sessionId,
    sessionTarget: { ...scope(), sessionId },
    timeoutMs: 30_000,
    workspaceDir: "/tmp",
    enqueue: async (task) => await task(),
    ...overrides,
  } satisfies RunEmbeddedAgentParams;
}

function createController(
  onSessionWriterClaimed?: (entry: InternalSessionEntry) => void,
  overrides: Partial<RunEmbeddedAgentParams> = {},
) {
  return createLaneControllerFixture(writerParams(overrides), {
    configureRuntime: false,
    globalLane: "writer-global",
    sessionLane: "writer-session",
    onSessionWriterClaimed,
  });
}

async function seedWriter(runId = "run-a", extra: Partial<InternalSessionEntry> = {}) {
  await replaceSessionEntry(scope(), {
    activeWriterRunId: runId,
    ...sessionRevision,
    updatedAt: 1,
    ...extra,
  } as InternalSessionEntry);
}

function installWriter(
  runId: string,
  cancel: Parameters<typeof setActiveEmbeddedRun>[1]["cancel"],
  stopped = false,
) {
  setActiveEmbeddedRun(
    sessionId,
    {
      kind: "embedded",
      runId,
      cancel,
      abort: vi.fn(),
      isCompacting: () => false,
      ...(stopped ? { isStopped: () => true } : {}),
      isStreaming: () => !stopped,
      queueMessage: async () => {},
    },
    sessionKey,
    sessionKey,
  );
}

function observeLifecycle(runId: string) {
  const events: unknown[] = [];
  onTestFinished(
    onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "lifecycle") {
        events.push(event);
      }
    }),
  );
  return events;
}

function captureStaleWriter(runId: string) {
  const fence = {
    ...scope(),
    expectedLifecycleRevision: lifecycleRevision,
    expectedWriterRunId: runId,
  };
  const manager = SessionManager.open({ ...fence, sessionId }, "/tmp");
  return async () => {
    expect(() => manager.appendMessage(assistantMessage("late model output"))).toThrow(
      SessionTranscriptWriterClaimReboundError,
    );
    expect(
      await appendExactAssistantMessageToSessionTranscript({
        ...fence,
        expectedSessionId: sessionId,
        message: assistantMessage("late output"),
      }),
    ).toMatchObject({ ok: false, code: "session-rebound" });
  };
}

describe("embedded run durable writer admission", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
    runsTesting.resetActiveEmbeddedRuns();
  });

  afterEach(() => {
    runsTesting.resetActiveEmbeddedRuns();
    resetAgentEventsForTest();
    vi.restoreAllMocks();
  });

  it("supersedes the live prior writer, claims the row, and rejects its late append", async () => {
    setRuntimeConfigSnapshot({});
    onTestFinished(clearRuntimeConfigSnapshot);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    await seedWriter();

    const takeoverOrder: string[] = [];
    const readWriter = () => (readEntry() as InternalSessionEntry | undefined)?.activeWriterRunId;
    const cancelA = vi.fn(() => takeoverOrder.push(`cancel:${readWriter()}`));
    installWriter("run-a", cancelA);
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    registerAgentRunContext("run-a", {
      agentId: "main",
      lifecycleGeneration,
      sessionId,
      sessionKey,
    });
    const assertStaleWriter = captureStaleWriter("run-a");
    let supersededOutcome: AgentRunTerminalOutcome | undefined;
    onTestFinished(
      onAgentEvent((event) => {
        if (event.runId === "run-a" && event.stream === "lifecycle" && event.data.phase === "end") {
          takeoverOrder.push(`record:${readWriter()}`);
          supersededOutcome = buildAgentRunTerminalOutcomeFromLifecycleEvent({
            phase: "end",
            data: event.data,
            endedAt: event.data.endedAt,
          });
        }
      }),
    );

    let admittedEntry: InternalSessionEntry | undefined;
    const { controller, getParams } = createController(
      (entry) => {
        admittedEntry = entry;
      },
      { lifecycleGeneration },
    );

    await controller.enqueueSession(() =>
      controller.enqueueGlobal(async () => {
        expect(admittedEntry).toMatchObject({
          activeWriterRunId: "run-b",
          ...sessionRevision,
        });
        return completedResult;
      }),
    );

    expect(cancelA).toHaveBeenCalledWith("superseded");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("live=true"));
    expect(takeoverOrder).toEqual(["record:run-b", "cancel:run-b"]);
    expect(supersededOutcome).toMatchObject({
      reason: "superseded",
      status: "error",
      stopReason: "superseded",
    });
    expect(readEntry()).toMatchObject({
      activeWriterRunId: "run-b",
      ...sessionRevision,
      updatedAt: 1,
    });
    expect(getParams().sessionTarget).toMatchObject({
      expectedLifecycleRevision: lifecycleRevision,
      expectedWriterRunId: "run-b",
    });
    await assertStaleWriter();
  });

  it("silently replaces a stopped prior writer while keeping stale transcript writes fenced", async () => {
    await seedWriter("run-stopped");
    const cancel = vi.fn();
    installWriter("run-stopped", cancel, true);
    const events = observeLifecycle("run-stopped");
    const assertStaleWriter = captureStaleWriter("run-stopped");

    await claimAgentSessionWriter(writerParams({ prompt: "next turn", runId: "run-next" }));

    expect(cancel).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(readEntry()).toMatchObject({ activeWriterRunId: "run-next", updatedAt: 1 });
    await assertStaleWriter();
  });

  it.each([false, true])(
    "keeps recovery-source SQL outside worker grants and checks the prepared read (revoked=%s)",
    async (revoke) => {
      const claim: HarnessCompletionRecovery = {
        taskId: "completion-task",
        taskRunId: "completion-task-run",
        taskStatus: "succeeded",
        sourceRunId: "announce:completion",
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        ...sessionRevision,
      };
      await seedWriter("run-a", {
        restartRecoveryHarnessCompletion: claim,
        restartRecoveryDeliveryRunId: claim.sourceRunId,
      });
      let sourceCurrent = true;
      const revoked = new Error("recovery source retired during preparation");
      const assertSourceCurrent = createHarnessCompletionSourceAssertion({
        claim,
        storePath: fixture.storePath(),
        priorAssertion() {
          if (!sourceCurrent) {
            throw revoked;
          }
        },
      });
      const prepared = prepareSystemAgentRunAdmission(
        {},
        "run-b",
        "main",
        "writer-test",
        assertSourceCurrent,
      );
      const admittedRunContext = await prepared.admit("embedded");
      const sameStoreQueriesInGrants: string[] = [];
      probe.admission(workerAdmission, (request, grant, callback) => {
        const sql = observeHostDataSql();
        try {
          callback(request, grant);
        } finally {
          sameStoreQueriesInGrants.push(
            ...sql.queries.filter((query) =>
              /\bsession_(?:nodes|windows|participants)\b/.test(query),
            ),
          );
          sql.restore();
        }
        if (revoke) {
          sourceCurrent = false;
        }
      });
      try {
        const claiming = claimAgentSessionWriter(writerParams({ admittedRunContext }));
        if (revoke) {
          await expect(claiming).rejects.toMatchObject({
            message: "admitted run authority is no longer active",
            cause: revoked,
          });
        } else {
          await claiming;
        }
        expect(readEntry()).toMatchObject({
          activeWriterRunId: revoke ? "run-a" : "run-b",
        });
        expect(sameStoreQueriesInGrants).toEqual([]);
      } finally {
        prepared.close();
      }
    },
  );

  it("leaves the incumbent live when the replacement claim does not commit", async () => {
    await seedWriter();
    const cancelA = vi.fn();
    installWriter("run-a", cancelA);
    const events = observeLifecycle("run-a");
    vi.spyOn(sessionEntryWriter, "applySessionEntryOperation").mockRejectedValueOnce(
      new Error("replacement claim conflict"),
    );
    const { controller } = createController();

    await expect(
      controller.enqueueSession(() => controller.enqueueGlobal(async () => completedResult)),
    ).rejects.toThrow("replacement claim conflict");

    expect(cancelA).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(readEntry()).toMatchObject({ activeWriterRunId: "run-a" });
  });
});
