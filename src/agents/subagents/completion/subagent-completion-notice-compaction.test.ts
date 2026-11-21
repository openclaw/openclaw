// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "../registry/subagent-control.test-support.js";
import { beforeEach, expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
} from "../../../config/sessions/session-accessor.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { sessionMutationHandlers } from "../../../gateway/server-methods/sessions-mutations.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../../sessions/session-controller.lifecycle.js";
import { acknowledgeSessionEffectTransition } from "../../../sessions/session-controller.owner-context.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import { acceptCompactionSuccessor } from "../../embedded-agent-runner/compaction-successor.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../registry/subagent-registry-persistence.js";
import { mutateRequesterSettleWakeBatch } from "../registry/subagent-registry-requester-wake-mutation.js";
import { registerSubagentRun } from "../registry/subagent-registry.js";
import { writeChildSession } from "../registry/subagent-registry.persistence.test-support.js";
import { records, requesterWakeDriver } from "./subagent-completion-admission.test-helpers.js";

const fixture = useSubagentControlFixture();
beforeEach(async () => captureRuntimeConfigAsyncReader()());
const requesterKey = "agent:main:main";
const childKey = "agent:main:subagent:notice-custody";
const runId = "notice-custody-run";

it.each(["compaction", "reset"] as const)(
  "retains completion through compaction and revokes it through Gateway reset (%s)",
  async (transition) => {
    const storePath = await writeChildSession(
      fixture.stateDir,
      requesterKey,
      "original-requester",
      "original-lifecycle",
    );
    await writeChildSession(fixture.stateDir, childKey, "child-session", "child-lifecycle");
    const read = (key: string) => loadSessionEntry({ storePath, sessionKey: key });
    await registerSubagentRun({
      runId,
      childSessionKey: childKey,
      childAgentId: "main",
      sessionEntry: read(childKey),
      requesterSessionKey: requesterKey,
      controllerSessionKey: "agent:main:telegram:default:direct:123",
      requesterAgentId: "main",
      requesterDisplayKey: requesterKey,
      task: "retain result",
      cleanup: "keep",
      expectsCompletionMessage: true,
    });
    await mutateSubagentRuns([runId], (rows) => {
      const draft = structuredClone(rows.get(runId)!);
      draft.execution = { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } };
      draft.completion = { required: true, capturedAt: Date.now(), resultText: "canonical result" };
      draft.requesterStorePath = storePath;
      draft.delivery = records().subagent.delivery;
      draft.cleanupHandled = true;
      draft.cleanupCompletedAt = Date.now();
      draft.completionRequesterSessionId = "original-requester";
      draft.completionRequesterLifecycleRevision = "original-lifecycle";
      draft.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        rearmGeneration: 1,
        batchRunIds: [runId],
      };
      return { value: undefined, postimages: new Map([[runId, draft]]) };
    });
    const admitted = subagentRuns.get(runId)!;
    const driver = requesterWakeDriver([{ subagent: admitted }]);
    try {
      if (transition === "compaction") {
        const target = captureSessionTarget({
          storeScope: storePath,
          physicalStorePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
          agentId: "main",
          sessionKey: requesterKey,
          incarnation: "original-requester",
        });
        const effect = await beginSessionEffect({ target });
        try {
          await effect.run(() =>
            acceptCompactionSuccessor({
              currentTarget: {
                agentId: "main",
                sessionKey: requesterKey,
                storePath,
                sessionId: "original-requester",
              },
              expectedEntry: {
                sessionId: "original-requester",
                lifecycleRevision: "original-lifecycle",
                activeWriterRunId: undefined,
              },
              assertActive: () => {},
              result: {
                ok: true,
                compacted: true,
                result: { sessionId: "compaction-successor", tokensBefore: 0 },
              },
              onCommitted: ({ admissionTransition }) => {
                if (admissionTransition)
                  acknowledgeSessionEffectTransition(target, admissionTransition);
              },
            }),
          );
        } finally {
          effect.release();
          await effect.released;
        }
        expect(read(requesterKey)?.sessionId).toBe("compaction-successor");
      } else {
        const respond = vi.fn();
        await sessionMutationHandlers["sessions.reset"]!({
          params: { key: requesterKey },
          context: createChatAbortContext({
            getRuntimeConfig,
            getSessionEventSubscriberConnIds: () => new Set(),
          }) as never,
          respond,
          client: { connect: { scopes: ["operator.admin"] } } as never,
          req: { type: "req", id: "reset", method: "sessions.reset" },
          isWebchatConnect: () => false,
        });
        const resetEntry = read(requesterKey);
        expect(resetEntry?.sessionId).toBe("original-requester");
        expect(resetEntry?.lifecycleRevision).toEqual(expect.any(String));
        expect(resetEntry?.lifecycleRevision).not.toBe("original-lifecycle");
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            ok: true,
            key: requesterKey,
            entry: expect.objectContaining({
              sessionId: resetEntry?.sessionId,
              lifecycleRevision: resetEntry?.lifecycleRevision,
            }),
          }),
          undefined,
        );
        expect(subagentRuns.get(runId)?.requesterSettleWake).toBeUndefined();
      }
      const result = await mutateRequesterSettleWakeBatch(
        driver.controller,
        [admitted],
        1,
        {
          kind: "settle",
          outcome: {
            delivered: false,
            path: "none",
            disposition: "permanent_failure",
            error: "requester failed",
          },
        },
        captureOpenClawStateWorkerContext(),
        {},
      );
      const current = read(requesterKey)!;
      const events = await loadTranscriptEvents({ storePath, sessionId: current.sessionId });
      const notices = events.filter(
        (event) =>
          event.type === "custom_message" && event.customType === "run-failed-before-reply",
      );
      if (transition === "compaction") {
        expect(result).toBe(true);
        expect(notices).toHaveLength(1);
        expect(JSON.stringify(notices[0])).toContain("canonical result");
      } else {
        expect(result).toBe(false);
        expect(notices).toHaveLength(0);
        expect(subagentRuns.get(runId)?.execution.outcome).toEqual({ status: "ok" });
      }
    } finally {
      driver.controller.clearRuntimeState();
    }
  },
  60_000,
);
