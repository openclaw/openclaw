import fs from "node:fs";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { readAcpSessionEntryAsync, upsertAcpSessionMeta } from "../runtime/session-meta.js";
import {
  readDurableAcpSignals,
  withAcpCancellationFixture,
} from "./manager.cancel-session.worker.test-support.js";
import { DEFAULT_DEPS } from "./manager.types.js";

it.each([
  ["durable", "cached-status"],
  ["durable", "cancel-rpc"],
  ["incognito", "metadata-write"],
] as const)(
  "preserves a %s same-entry runtime replacement while %s is pending and permits retry",
  async (sourceKind, boundary) => {
    await withAcpCancellationFixture(
      async (f) => {
        const path = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: f.state.env });
        const memory = memorySessionActorOwners.read({ agentId: "main", path });
        const assertMemoryCurrent = () => {
          if (sourceKind === "incognito") {
            expect(memory).toBeDefined();
            expect(memorySessionActorOwners.read({ agentId: "main", path })).toBe(memory);
            expect(fs.existsSync(path)).toBe(false);
          }
        };
        assertMemoryCurrent();
        // Prime the real cache so ensure cannot publish a new handle over the replacement.
        await f.manager.getSessionStatus(f.target);
        expect(f.ensureSession).toHaveBeenCalledOnce();
        const replaceRuntime = () =>
          upsertAcpSessionMeta({
            ...f.target,
            skipMaintenance: true,
            mutate: (current) => {
              if (!current) {
                throw new Error("Fixture lost its global ACP metadata before replacement.");
              }
              return { ...current, runtimeSessionName: "successor-runtime", state: "running" };
            },
          });
        const entered = createDeferred();
        const release = createDeferred();
        if (boundary === "cached-status") {
          f.getStatus.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return { summary: "ready" };
          });
        } else if (boundary === "cancel-rpc") {
          f.cancel.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
          });
        }
        const upsert = DEFAULT_DEPS.upsertSessionMeta;
        const writer =
          boundary === "metadata-write"
            ? vi.spyOn(DEFAULT_DEPS, "upsertSessionMeta").mockImplementationOnce(async (params) => {
                entered.resolve();
                await release.promise;
                return upsert(params);
              })
            : undefined;
        const close = vi.spyOn(f.runtime, "close");
        const cancellation = f.manager.cancelSession({
          ...f.target,
          expectedOwnerKey: "agent:main:main",
          reason: "locator-replacement",
        });
        const result = Promise.allSettled([cancellation]);
        try {
          const initialCancelCalls = boundary === "cached-status" ? 0 : 1;
          await awaitGateBeforeSettlement(
            entered.promise,
            result,
            "Cancellation settled before the held runtime boundary.",
          );
          expect(f.cancel).toHaveBeenCalledTimes(initialCancelCalls);
          await replaceRuntime();
          release.resolve();
          const outcomes = await result;
          const current = await readAcpSessionEntryAsync(f.target);
          expect(current?.acp).toMatchObject({
            backend: "cancellation-proof",
            runtimeSessionName: "successor-runtime",
            mode: "persistent",
            state: "running",
          });
          expect(current?.entry).toMatchObject({
            sessionId: "cancellation-session",
            lifecycleRevision: "cancellation-lifecycle",
            spawnedBy: "agent:main:main",
          });
          expect(outcomes).toMatchObject([{ status: "rejected" }]);
          expect(f.cancel).toHaveBeenCalledTimes(initialCancelCalls);
          if (initialCancelCalls === 1) {
            expect(f.cancel).toHaveBeenCalledExactlyOnceWith({
              handle: expect.objectContaining({ runtimeSessionName: "retained-runtime" }),
              reason: "locator-replacement",
            });
          }
          expect(f.ensureSession).toHaveBeenCalledOnce();
          expect(close).not.toHaveBeenCalled();
          assertMemoryCurrent();

          f.ensureSession.mockImplementationOnce(async () => ({
            sessionKey: f.target.sessionKey,
            backend: "cancellation-proof",
            runtimeSessionName: "successor-runtime",
          }));
          await f.manager.cancelSession({
            ...f.target,
            expectedOwnerKey: "agent:main:main",
            reason: "successor-retry",
          });
          expect(f.ensureSession).toHaveBeenCalledTimes(2);
          expect(f.cancel).toHaveBeenCalledTimes(initialCancelCalls + 1);
          expect(f.cancel).toHaveBeenLastCalledWith({
            handle: expect.objectContaining({ runtimeSessionName: "successor-runtime" }),
            reason: "successor-retry",
          });
          expect((await readAcpSessionEntryAsync(f.target))?.acp).toMatchObject({
            runtimeSessionName: "successor-runtime",
            state: "idle",
          });
          expect(close).not.toHaveBeenCalled();
          assertMemoryCurrent();
        } finally {
          release.resolve();
          await result;
          writer?.mockRestore();
          // Fixture disposal owns its ordinary close after the cancellation assertions.
          close.mockRestore();
        }
      },
      {
        sessionKey:
          sourceKind === "incognito"
            ? "agent:main:dashboard:incognito-locator-retry"
            : "agent:main:acp:locator-retry",
      },
    );
  },
);

it.each([
  ["incognito", "named-backend"],
  ["durable", "empty-backend"],
] as const)(
  "cancels the normalized %s handle from %s and persists its idle state",
  async (sourceKind, returnedBackend) => {
    await withAcpCancellationFixture(
      async (f) => {
        const path = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: f.state.env });
        const memory = memorySessionActorOwners.read({ agentId: "main", path });
        if (sourceKind === "incognito") {
          expect(memory).toBeDefined();
          expect(fs.existsSync(path)).toBe(false);
        }
        f.ensureSession.mockImplementationOnce(async () => ({
          sessionKey: f.target.sessionKey,
          backend: returnedBackend === "empty-backend" ? "" : "cancellation-proof",
          runtimeSessionName: "normalized-runtime",
        }));
        const close = vi.spyOn(f.runtime, "close");
        try {
          await f.manager.cancelSession({
            ...f.target,
            expectedOwnerKey: "agent:main:main",
            reason: "normalized-cancel",
          });
          expect(f.cancel).toHaveBeenCalledExactlyOnceWith({
            handle: expect.objectContaining({
              backend: "cancellation-proof",
              runtimeSessionName: "normalized-runtime",
            }),
            reason: "normalized-cancel",
          });
          expect((await readAcpSessionEntryAsync(f.target))?.acp).toMatchObject({
            backend: "cancellation-proof",
            runtimeSessionName: "normalized-runtime",
            mode: "persistent",
            state: "idle",
          });
          expect(close).not.toHaveBeenCalled();
          if (sourceKind === "incognito") {
            expect(memorySessionActorOwners.read({ agentId: "main", path })).toBe(memory);
            expect(fs.existsSync(path)).toBe(false);
          }
        } finally {
          close.mockRestore();
        }
      },
      {
        sessionKey:
          sourceKind === "incognito"
            ? "agent:main:dashboard:incognito-locator-normalization"
            : "agent:main:acp:locator-normalization",
      },
    );
  },
);

it.each([
  ["incognito", "post-abort-read", "cancelled"],
  ["durable", "cancel-rpc", "completed"],
] as const)(
  "settles %s active cancellation held at %s with a %s producer without publishing over its replacement",
  async (sourceKind, boundary, terminalStatus) => {
    await withAcpCancellationFixture(
      async (f) => {
        const path = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: f.state.env });
        const memory = memorySessionActorOwners.read({ agentId: "main", path });
        if (sourceKind === "incognito") {
          expect(memory).toBeDefined();
          expect(fs.existsSync(path)).toBe(false);
        }
        const turnEntered = createDeferred();
        const releaseTurn = createDeferred();
        const readEntered = createDeferred();
        const releaseRead = createDeferred();
        const cancelEntered = createDeferred();
        const releaseCancel = createDeferred();
        let signal: AbortSignal | undefined;
        f.runTurn.mockImplementationOnce(async function* (input) {
          signal = input.signal;
          turnEntered.resolve();
          // The producer reports its own outcome independently of cancellation RPC settlement.
          await releaseTurn.promise;
          yield { type: "done", status: terminalStatus };
        });
        f.cancel.mockImplementationOnce(async () => {
          cancelEntered.resolve();
          await releaseCancel.promise;
        });
        const prepare = DEFAULT_DEPS.prepareSessionControlRead;
        let gated = false;
        const reader = vi
          .spyOn(DEFAULT_DEPS, "prepareSessionControlRead")
          .mockImplementationOnce(async (params) => {
            const read = await prepare(params);
            return {
              ...read,
              readCurrent: async (cfg: typeof f.target.cfg) => {
                if (boundary === "post-abort-read" && signal?.aborted && !gated) {
                  gated = true;
                  readEntered.resolve();
                  await releaseRead.promise;
                }
                return read.readCurrent(cfg);
              },
            };
          });
        const close = vi.spyOn(f.runtime, "close");
        const context = createTestAdmittedRunContext("active-locator");
        const events: unknown[] = [];
        let turnSettled = false;
        let cancelSettled = false;
        const turn = f.manager.runTurn({
          ...f.target,
          admittedRunContext: context,
          provenance: "system",
          mode: "prompt",
          text: "active locator",
          requestId: "active-locator",
          onEvent: (event) => {
            events.push(event);
          },
        });
        const turnResult = Promise.allSettled([turn]).then((result) => {
          turnSettled = true;
          return result;
        });
        let cancelResult: Promise<PromiseSettledResult<void>[]> | undefined;
        try {
          await awaitGateBeforeSettlement(
            turnEntered.promise,
            turnResult,
            "Turn settled before runtime entry.",
          );
          const cancellation = f.manager.cancelSession({
            ...f.target,
            expectedRunId: "active-locator",
            expectedInstanceId: context.operationalRunInstance.instanceId,
            expectedOwnerKey: "agent:main:main",
            reason: "active-locator-replacement",
          });
          cancelResult = Promise.allSettled([cancellation]).then((result) => {
            cancelSettled = true;
            return result;
          });
          await awaitGateBeforeSettlement(
            boundary === "post-abort-read" ? readEntered.promise : cancelEntered.promise,
            cancelResult,
            "Stop settled before its held cancellation boundary.",
          );
          expect(signal?.aborted).toBe(true);
          expect(f.cancel).toHaveBeenCalledTimes(boundary === "post-abort-read" ? 0 : 1);
          await upsertAcpSessionMeta({
            ...f.target,
            skipMaintenance: true,
            mutate: (current) => {
              if (!current) {
                throw new Error("Active fixture lost its global ACP metadata.");
              }
              return { ...current, runtimeSessionName: "successor-runtime", state: "running" };
            },
          });
          releaseRead.resolve();
          releaseTurn.resolve();
          await awaitGateBeforeSettlement(
            cancelEntered.promise,
            cancelResult,
            "An admitted Stop abandoned its captured runtime cleanup.",
          );
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(turnSettled).toBe(false);
          expect(cancelSettled).toBe(false);
          expect(close).not.toHaveBeenCalled();
          releaseCancel.resolve();
          await Promise.all([turnResult, cancelResult]);
          expect(turnSettled).toBe(true);
          expect(cancelSettled).toBe(true);
          expect((await readAcpSessionEntryAsync(f.target))?.acp).toMatchObject({
            backend: "cancellation-proof",
            runtimeSessionName: "successor-runtime",
            mode: "persistent",
            state: "running",
          });
          expect(readDurableAcpSignals(f, "active-locator")).toEqual([]);
          expect(events).toContainEqual({ type: "done", status: terminalStatus });
          expect(f.cancel).toHaveBeenCalledExactlyOnceWith({
            handle: expect.objectContaining({ runtimeSessionName: "retained-runtime" }),
            reason: "active-locator-replacement",
          });
          expect(close).not.toHaveBeenCalled();
          if (sourceKind === "incognito") {
            expect(memorySessionActorOwners.read({ agentId: "main", path })).toBe(memory);
            expect(fs.existsSync(path)).toBe(false);
          }
        } finally {
          releaseRead.resolve();
          releaseTurn.resolve();
          releaseCancel.resolve();
          await Promise.allSettled([turnResult, cancelResult]);
          reader.mockRestore();
          close.mockRestore();
        }
      },
      {
        sessionKey:
          sourceKind === "incognito"
            ? "agent:main:dashboard:incognito-active-locator"
            : "agent:main:acp:active-locator",
      },
    );
  },
);
