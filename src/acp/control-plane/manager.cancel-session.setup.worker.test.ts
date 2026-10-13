import fs from "node:fs";
import { createIdentityFromStatus } from "@openclaw/acp-core/runtime/session-identity";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { prepareOperatorModelPolicy } from "../../agents/operator-model-policy.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { readAcpSessionEntry, upsertAcpSessionMeta } from "../runtime/session-meta.js";
import {
  readDurableAcpSignals,
  withAcpCancellationFixture,
} from "./manager.cancel-session.worker.test-support.js";
import { DEFAULT_DEPS } from "./manager.types.js";

it("preserves replacement metadata when a cancelled late handle fails its applied-model policy", async () => {
  await withAcpCancellationFixture(async (f) => {
    await upsertAcpSessionMeta({
      ...f.target,
      skipMaintenance: true,
      mutate: (current) => {
        if (!current) {
          throw new Error("Policy fixture lost its global ACP metadata.");
        }
        return { ...current, runtimeOptions: { model: "fixture/allowed" } };
      },
    });
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "fixture-operator",
      scopes: ["operator.write"],
      assertCurrent: () => {},
      modelPolicy: prepareOperatorModelPolicy({
        cfg: f.target.cfg,
        policy: { allow: ["fixture/allowed"] },
        manifestPlugins: [],
      }),
    });
    const admission = prepareSystemAgentRunAdmission(
      f.target.cfg,
      "policy-locator",
      "main",
      "test",
      undefined,
      authority,
    );
    const ensureEntered = createDeferred();
    const releaseEnsure = createDeferred();
    const stopAdmitted = createDeferred();
    const publicationReadEntered = createDeferred();
    const releasePublicationRead = createDeferred();
    let ensureReturned = false;
    let controlPrepared = false;
    let gated = false;
    f.ensureSession.mockImplementationOnce(async () => {
      ensureEntered.resolve();
      await releaseEnsure.promise;
      ensureReturned = true;
      return {
        sessionKey: f.target.sessionKey,
        backend: "cancellation-proof",
        runtimeSessionName: "retained-runtime",
        appliedModel: { kind: "applied", model: "fixture/denied" },
      };
    });
    f.getStatus.mockResolvedValue({ agentSessionId: "old-runtime-observation" });
    const prepare = DEFAULT_DEPS.prepareSessionControlRead;
    const reader = vi
      .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
      .mockImplementationOnce(async (params) => {
        const read = await prepare(params);
        controlPrepared = true;
        return {
          ...read,
          readCurrent: async (cfg: typeof f.target.cfg) => {
            if (ensureReturned && !gated) {
              gated = true;
              publicationReadEntered.resolve();
              await releasePublicationRead.promise;
            }
            return read.readCurrent(cfg);
          },
        };
      });
    const close = vi.spyOn(f.runtime, "close");
    let turnResult: Promise<PromiseSettledResult<void>[]> | undefined;
    let cancelResult: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      const context = await admission.admit("acp");
      const turn = f.manager.runTurn({
        ...f.target,
        admittedRunContext: context,
        provenance: "system",
        mode: "prompt",
        text: "late policy locator",
        requestId: "policy-locator",
      });
      turnResult = Promise.allSettled([turn]);
      await awaitGateBeforeSettlement(
        ensureEntered.promise,
        turnResult,
        "Policy turn settled before backend ensure.",
      );
      const cancellation = f.manager.cancelSession({
        ...f.target,
        expectedRunId: "policy-locator",
        expectedInstanceId: context.operationalRunInstance.instanceId,
        expectedOwnerKey: "agent:main:main",
        assertActive: () => {
          if (controlPrepared) {
            stopAdmitted.resolve();
          }
        },
      });
      cancelResult = Promise.allSettled([cancellation]);
      await awaitGateBeforeSettlement(
        stopAdmitted.promise,
        cancelResult,
        "Stop settled before accepting late-handle cleanup.",
      );
      releaseEnsure.resolve();
      await awaitGateBeforeSettlement(
        publicationReadEntered.promise,
        turnResult,
        "Policy failure did not reach terminal publication validation.",
      );
      expect(f.runTurn).not.toHaveBeenCalled();
      const successorIdentity = createIdentityFromStatus({
        status: { agentSessionId: "successor-agent" },
        now: 200,
      });
      await upsertAcpSessionMeta({
        ...f.target,
        skipMaintenance: true,
        mutate: (current) => {
          if (!current) {
            throw new Error("Policy fixture lost its metadata before successor publication.");
          }
          return {
            ...current,
            runtimeSessionName: "successor-runtime",
            identity: successorIdentity,
            state: "running",
          };
        },
      });
      releasePublicationRead.resolve();
      await Promise.all([turnResult, cancelResult]);
      expect(await turnResult).toMatchObject([{ status: "rejected" }]);
      expect(readAcpSessionEntry(f.target)?.acp).toMatchObject({
        backend: "cancellation-proof",
        runtimeSessionName: "successor-runtime",
        state: "running",
        identity: successorIdentity,
      });
      expect(readDurableAcpSignals(f, "policy-locator")).toEqual([]);
      expect(f.ensureSession).toHaveBeenCalledOnce();
      expect(f.runTurn).not.toHaveBeenCalled();
      expect(f.cancel).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      releaseEnsure.resolve();
      releasePublicationRead.resolve();
      await Promise.allSettled([turnResult, cancelResult]);
      reader.mockRestore();
      close.mockRestore();
      admission.close();
    }
  });
});

it("preserves a durable replacement while cold cancellation ensure normalizes its handle", async () => {
  await withAcpCancellationFixture(
    async (f) => {
      const entered = createDeferred();
      const release = createDeferred();
      f.ensureSession.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return {
          sessionKey: f.target.sessionKey,
          backend: "cancellation-proof",
          runtimeSessionName: "normalized-runtime",
        };
      });
      const close = vi.spyOn(f.runtime, "close");
      const cancellation = f.manager.cancelSession({
        ...f.target,
        expectedOwnerKey: "agent:main:main",
        reason: "cold-ensure-replacement",
      });
      const result = Promise.allSettled([cancellation]);
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          result,
          "Cold cancellation settled before runtime ensure.",
        );
        await upsertAcpSessionMeta({
          ...f.target,
          skipMaintenance: true,
          mutate: (current) => {
            if (!current) {
              throw new Error("Cold fixture lost its global ACP metadata.");
            }
            return { ...current, runtimeSessionName: "successor-runtime", state: "running" };
          },
        });
        release.resolve();
        const outcomes = await result;
        expect(readAcpSessionEntry(f.target)?.acp).toMatchObject({
          backend: "cancellation-proof",
          runtimeSessionName: "successor-runtime",
          state: "running",
        });
        expect(outcomes).toMatchObject([{ status: "rejected" }]);
        expect(f.ensureSession).toHaveBeenCalledOnce();
        expect(f.cancel).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await result;
        close.mockRestore();
      }
    },
    {
      sessionKey: "agent:main:acp:cold-locator",
    },
  );
});

it.each([
  ["durable", "ensure"],
  ["durable", "metadata-write"],
  ["incognito", "metadata-write"],
] as const)(
  "joins %s cancelled setup at %s without publishing normalization over a replacement",
  async (sourceKind, boundary) => {
    await withAcpCancellationFixture(
      async (f) => {
        const path = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: f.state.env });
        const memory = getOpenIncognitoAgentDatabase("main", path);
        if (sourceKind === "incognito") {
          expect(memory).toBeDefined();
          expect(memory?.db.location()).toBeFalsy();
          expect(fs.existsSync(path)).toBe(false);
        }
        const reached = createDeferred();
        const release = createDeferred();
        const admitted = createDeferred();
        f.ensureSession.mockImplementationOnce(async () => {
          if (boundary === "ensure") {
            reached.resolve();
            await release.promise;
          }
          return {
            sessionKey: f.target.sessionKey,
            backend: "cancellation-proof",
            runtimeSessionName: "normalized-runtime",
          };
        });
        const upsert = DEFAULT_DEPS.upsertSessionMeta;
        const patchEntry = sessionAccessor.patchSessionEntryWithKey;
        const writer =
          boundary === "ensure"
            ? undefined
            : sourceKind === "durable"
              ? vi
                  .spyOn(DEFAULT_DEPS, "upsertSessionMeta")
                  .mockImplementationOnce(async (params) => {
                    reached.resolve();
                    await release.promise;
                    return upsert(params);
                  })
              : vi
                  .spyOn(sessionAccessor, "patchSessionEntryWithKey")
                  .mockImplementationOnce(async (...args) => {
                    // Complete the actual memory-entry mutation before holding global publication.
                    const result = await patchEntry(...args);
                    reached.resolve();
                    await release.promise;
                    return result;
                  });
        const prepare = DEFAULT_DEPS.prepareSessionControlRead;
        let controlPrepared = false;
        const reader = vi
          .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
          .mockImplementationOnce(async (params) => {
            const read = await prepare(params);
            controlPrepared = true;
            return read;
          });
        const close = vi.spyOn(f.runtime, "close");
        const context = createTestAdmittedRunContext("delayed-normalization");
        let turnSettled = false;
        let cancelSettled = false;
        const turn = f.manager.runTurn({
          ...f.target,
          admittedRunContext: context,
          provenance: "system",
          mode: "prompt",
          text: "delayed normalization",
          requestId: "delayed-normalization",
        });
        const turnResult = Promise.allSettled([turn]).then((result) => {
          turnSettled = true;
          return result;
        });
        let cancelResult: Promise<PromiseSettledResult<void>[]> | undefined;
        try {
          await awaitGateBeforeSettlement(
            reached.promise,
            turnResult,
            "Normalization settled before its write gate.",
          );
          expect(readAcpSessionEntry(f.target)?.acp?.runtimeSessionName).toBe("retained-runtime");
          expect(f.runTurn).not.toHaveBeenCalled();
          const cancellation = f.manager.cancelSession({
            ...f.target,
            expectedRunId: "delayed-normalization",
            expectedInstanceId: context.operationalRunInstance.instanceId,
            expectedOwnerKey: "agent:main:main",
            assertActive: () => {
              if (controlPrepared) {
                admitted.resolve();
              }
            },
          });
          cancelResult = Promise.allSettled([cancellation]).then((result) => {
            cancelSettled = true;
            return result;
          });
          await awaitGateBeforeSettlement(
            admitted.promise,
            cancelResult,
            "Stop settled before delayed-write cancellation admission.",
          );
          await upsertAcpSessionMeta({
            ...f.target,
            skipMaintenance: true,
            mutate: (current) => {
              if (!current) {
                throw new Error("Delayed normalization lost its global ACP metadata.");
              }
              return { ...current, runtimeSessionName: "successor-runtime", state: "running" };
            },
          });
          expect(turnSettled).toBe(false);
          expect(cancelSettled).toBe(false);
          release.resolve();
          await Promise.all([turnResult, cancelResult]);
          expect(turnSettled).toBe(true);
          expect(cancelSettled).toBe(true);
          expect(readAcpSessionEntry(f.target)?.acp).toMatchObject({
            backend: "cancellation-proof",
            runtimeSessionName: "successor-runtime",
            state: "running",
          });
          expect(readDurableAcpSignals(f, "delayed-normalization")).toEqual([]);
          expect(f.ensureSession).toHaveBeenCalledOnce();
          expect(f.runTurn).not.toHaveBeenCalled();
          expect(f.cancel).not.toHaveBeenCalled();
          expect(close).not.toHaveBeenCalled();
          if (sourceKind === "incognito") {
            expect(getOpenIncognitoAgentDatabase("main", path)).toBe(memory);
            expect(fs.existsSync(path)).toBe(false);
          }
        } finally {
          release.resolve();
          await Promise.allSettled([turnResult, cancelResult]);
          reader.mockRestore();
          writer?.mockRestore();
          close.mockRestore();
        }
      },
      {
        sessionKey:
          sourceKind === "incognito"
            ? "agent:main:dashboard:incognito-delayed-normalization"
            : "agent:main:acp:delayed-normalization",
      },
    );
  },
);
