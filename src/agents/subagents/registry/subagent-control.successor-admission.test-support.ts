import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import {
  consumeSessionEffectHandoff,
  getSessionMutationCount,
} from "../../../sessions/session-controller.lifecycle.js";
import type { SubagentRunRecordOverrides } from "../../subagent-test-fixtures.test-helpers.js";
import { startControlProducer as startProducer } from "./subagent-control-native.test-support.js";
import { beginControlAdmission } from "./subagent-control.fixtures.test-support.js";
import type { killAllControlledSubagentRuns, killSubagentRunAdmin } from "./subagent-control.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { replaceSubagentRunAfterSteerCore } from "./subagent-registry.js";
import { getSubagentRunByChildSessionKey as latestRun } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Live successor admission retains the control suite's physical stores and authority fixture. */
export function registerSuccessorAdmissionControlTests({
  addRun,
  runFixture,
  writeSession,
  adminKill,
  controlledKill,
  expectRunning,
  adminOwner,
}: {
  addRun: (overrides: SubagentRunRecordOverrides) => Promise<SubagentRunRecord>;
  runFixture: (
    suffix: string,
    overrides?: Partial<SubagentRunRecordOverrides>,
  ) => SubagentRunRecord;
  writeSession: (
    label: string,
    sessionKey: string,
    entry: Partial<SessionEntry>,
  ) => Promise<string>;
  adminKill: (
    sessionKey: string,
    storePath?: string,
    expected?: Partial<Parameters<typeof killSubagentRunAdmin>[0]>,
  ) => ReturnType<typeof killSubagentRunAdmin>;
  controlledKill: (
    runs: SubagentRunRecord[],
    storePath?: string,
  ) => ReturnType<typeof killAllControlledSubagentRuns>;
  expectRunning: (sessionKey: string, expected: Partial<SubagentRunRecord>) => Promise<void>;
  adminOwner: Pick<
    SubagentRunRecord,
    "controllerSessionKey" | "requesterSessionKey" | "requesterDisplayKey"
  >;
}) {
  it.each(["exact admin", "controlled"] as const)(
    "interrupts selected admission without retargeting an exact admin kill (%s)",
    async (mode) => {
      const exact = mode === "exact admin";
      const sessionId = "sess-live-admission";
      const entry = await addRun(
        runFixture("live-admission", {
          childSessionIdentity: { sessionId },
          createdAt: Date.now() - 2_000,
          ...(exact
            ? {
                ...adminOwner,
                completion: { required: false },
                delivery: { status: "pending" },
                generation: 1,
              }
            : { requesterSessionKey: "agent:main:main" }),
          execution: {
            status: "running",
            startedAt: Date.now() - 1_000,
          },
        }),
      );
      const { childSessionKey } = entry;
      const storePath = await writeSession("live-admission", childSessionKey, {
        sessionId,
        updatedAt: Date.now(),
        abortedLastRun: true,
      });
      const interrupted = createDeferred();
      const admission = await beginControlAdmission(
        storePath,
        childSessionKey,
        sessionId,
        () => {
          interrupted.resolve();
          return { runId: entry.runId };
        },
        entry.runId,
      );
      const handoffId = admission.createHandoff();
      const successorInterrupted = vi.fn();
      const abort = exact
        ? startProducer(childSessionKey, sessionId, storePath, undefined, "live-successor").cancel
        : undefined;
      const successorAdmission = exact
        ? await beginControlAdmission(
            storePath,
            childSessionKey,
            sessionId,
            undefined,
            "live-successor",
          )
        : undefined;
      const pendingKill = exact
        ? adminKill(childSessionKey, storePath, { expectedRunId: entry.runId })
        : controlledKill([entry], storePath);
      let adopted: ReturnType<typeof consumeSessionEffectHandoff>;
      try {
        await interrupted.promise;
        expect(getSessionMutationCount()).toBeGreaterThan(0);
        adopted = consumeSessionEffectHandoff({
          handoffId,
          scope: storePath,
          identities: [childSessionKey, sessionId],
          onInterrupt: successorInterrupted,
        });
        expect(adopted).toBeDefined();
        if (exact) {
          // A live successor uses its own admission, not recovery adoption of a kill-claimed row.
          expect(
            await successorAdmission?.run(() =>
              replaceSubagentRunAfterSteerCore({
                previousRunId: entry.runId,
                nextRunId: "live-successor",
              }),
            ),
          ).toBe(true);
        } else {
          expect(successorInterrupted).toHaveBeenCalledOnce();
        }
        adopted?.release();
        if (exact) {
          await expect(pendingKill).resolves.toMatchObject({
            found: true,
            killed: false,
            runId: entry.runId,
          });
          await expectRunning(childSessionKey, { runId: "live-successor" });
          expect(abort).not.toHaveBeenCalled();
        } else {
          await expect(pendingKill).resolves.toMatchObject({ status: "ok" });
          await expect(admission.released).resolves.toBeUndefined();
          expect(await latestRun(childSessionKey)).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
            execution: { status: "terminal" },
          });
        }
      } finally {
        adopted?.release();
        admission.release();
        successorAdmission?.release();
        await pendingKill;
      }
    },
  );
}
