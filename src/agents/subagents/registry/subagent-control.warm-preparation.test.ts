// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { loadExactSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import * as preparedFacts from "../../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { prepareSessionGenerationFacts } from "../../../config/sessions/session-delivery-generation.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { runOutsideAsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as writerQueue from "../../../shared/store-writer-queue.js";
import type { OpenClawAgentDatabaseExecution } from "../../../state/openclaw-agent-execution-contract.js";
import * as executionOwner from "../../../state/openclaw-agent-execution.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../../state/openclaw-agent-write-admission-state.js";
import {
  prepareSubagentKillSession,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import { createControlRunFixture } from "./subagent-control.fixtures.test-support.js";

const fixture = useSubagentControlFixture();
const { writeSession } = createControlRunFixture(() => fixture.stateDir);

it.for(["unrelated", "same session"] as const)(
  "prepares warm cancellation with a %s write while retaining publication ordering",
  async (writerTarget, { signal }) => {
    const childKey = "agent:main:subagent:warm-preparation";
    const childId = "warm-preparation-session";
    const revision = "warm-preparation-revision";
    const peerKey = "agent:main:subagent:unrelated-publication";
    const peerId = "unrelated-publication-session";
    const producerScope = new AsyncLocalStorage<boolean>();
    const operationScope = new AsyncLocalStorage<"preparation" | "publication">();
    const nativeReplyHeld = createDeferredCore();
    const releaseNativeReply = createDeferredCore();
    const preparationQueued = createDeferredCore();
    const publicationQueued = createDeferredCore();
    const generationPublicationPending = createDeferredCore();
    let nativeReplyPending = false;
    let producerPath: string | undefined;
    let initial: SubagentKillSession | undefined;
    let prepared: SubagentKillSession | undefined;
    let execution: OpenClawAgentDatabaseExecution | undefined;
    let generationFacts: Awaited<ReturnType<typeof prepareSessionGenerationFacts>> | undefined;
    let producer: Promise<void> | undefined;
    let preparation: Promise<SubagentKillSession> | undefined;
    let publication: Promise<void> | undefined;
    const release = () => releaseNativeReply.resolve();
    signal.addEventListener("abort", release, { once: true });
    const gate = (ready: Promise<unknown>, pending: Promise<unknown>, message: string) =>
      withinTest(awaitGateBeforeSettlement(ready, pending, message), signal);
    const identity = { sessionId: childId, lifecycleRevision: revision };
    const prepare = (assertCurrent: () => void) =>
      prepareSubagentKillSession(
        getRuntimeConfig(),
        childKey,
        assertCurrent,
        undefined,
        "main",
        identity,
      );
    const expectPublication = (sessionKey: string, sessionId: string) =>
      expect(
        loadExactSessionEntryReadOnly({ storePath: initial!.storePath, sessionKey })?.entry,
      ).toMatchObject({ sessionId, label: "held write published" });

    try {
      const storePath = await writeSession("warm-preparation", revision);
      await writeSession("unrelated-publication");
      const writerKey = writerTarget === "unrelated" ? peerKey : childKey;
      const writerSessionId = writerTarget === "unrelated" ? peerId : childId;
      initial = await prepare(() => {});
      execution = executionOwner.captureOpenClawAgentDatabaseExecution({
        agentId: "main",
        env: process.env,
      });
      const nativeClaim = execution.captureGenerationClaim();
      nativeClaim.assertCurrent();
      initial.assertCurrent();

      const retainFacts = preparedFacts.retainPreparedSessionGenerationFacts;
      vi.spyOn(preparedFacts, "retainPreparedSessionGenerationFacts").mockImplementation(
        (params) => {
          const facts = retainFacts(params);
          return {
            ...facts,
            prepareRead() {
              const pending = facts.prepareRead();
              if (operationScope.getStore() === "preparation" && pending) {
                generationPublicationPending.resolve();
              }
              return pending;
            },
          };
        },
      );

      const runQueued = writerQueue.runQueuedStoreWrite;
      vi.spyOn(writerQueue, "runQueuedStoreWrite").mockImplementation((params) => {
        if (params.queues !== SQLITE_SESSION_WRITER_QUEUES) {
          return runQueued(params);
        }
        if (producerScope.getStore()) {
          producerPath ??= params.storePath;
        }
        const observing = operationScope.getStore();
        const before =
          observing && nativeReplyPending && params.storePath === producerPath
            ? new Set(params.queues.get(params.storePath)?.pending ?? [])
            : undefined;
        const result = runQueued(params);
        if (
          before &&
          params.queues.get(params.storePath)?.pending.some((entry) => !before.has(entry))
        ) {
          (observing === "preparation" ? preparationQueued : publicationQueued).resolve();
        }
        return result;
      });
      const wrapExecution = (borrowed: OpenClawAgentDatabaseExecution) => {
        if (!producerScope.getStore()) {
          return borrowed;
        }
        const runExisting: typeof borrowed.runExisting = (source, operation, options) =>
          borrowed.runExisting(
            source,
            (scope) =>
              operation({
                async execute(command, commandOptions) {
                  const value = await scope.execute(command, commandOptions);
                  if (command.type === "session.entries.replace" && !nativeReplyPending) {
                    // The real write has replied; its owner still retains publication custody.
                    nativeReplyPending = true;
                    nativeReplyHeld.resolve();
                    await releaseNativeReply.promise;
                  }
                  return value;
                },
              }),
            options,
          );
        return new Proxy(borrowed, {
          get(original, key, receiver) {
            return key === "runExisting" ? runExisting : Reflect.get(original, key, receiver);
          },
        });
      };
      const captureExecution = executionOwner.captureOpenClawAgentDatabaseExecution;
      vi.spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution").mockImplementation(
        (...args) => wrapExecution(captureExecution(...args)),
      );
      const capturePreparation = executionOwner.captureOpenClawAgentDatabasePreparationExecution;
      vi.spyOn(
        executionOwner,
        "captureOpenClawAgentDatabasePreparationExecution",
      ).mockImplementation((...args) => wrapExecution(capturePreparation(...args)));
      producer = runOutsideAsyncWorkScope(() =>
        runWithGatewayIndependentRootWorkAdmission(
          () =>
            producerScope.run(true, () =>
              applySessionEntryExactReplacements({
                agentId: "main",
                storePath,
                sessionKeys: [writerKey],
                activeSessionKey: writerKey,
                skipMaintenance: true,
                requireWriteSuccess: true,
                update(entries) {
                  const peer = entries.find((entry) => entry.sessionKey === writerKey)?.entry;
                  if (!peer || peer.sessionId !== writerSessionId) {
                    throw new Error("Held writer lost its original session");
                  }
                  return {
                    result: undefined,
                    replacements: [
                      { sessionKey: writerKey, entry: { ...peer, label: "held write published" } },
                    ],
                  };
                },
              }),
            ),
          "test:warm-cancellation-publication",
          signal,
        ),
      );
      await gate(nativeReplyHeld.promise, producer, "Writer publication was not held");
      // Both the retained native incarnation and freshly read A facts are valid while B's
      // publication remains pending. A is not waiting for its own generation to settle.
      nativeClaim.assertCurrent();
      if (writerTarget === "unrelated") {
        initial.assertCurrent();
        generationFacts = await prepareSessionGenerationFacts({
          agentId: "main",
          storePath,
          sessionKey: childKey,
          ...identity,
        });
        generationFacts.assertCurrent();
      }
      preparation = operationScope.run("preparation", () =>
        prepare(() => nativeClaim.assertCurrent()),
      );
      if (writerTarget === "same session") {
        await gate(
          Promise.race([preparationQueued.promise, generationPublicationPending.promise]),
          preparation,
          "Preparation bypassed its own pending session publication",
        );
        release();
        prepared = await preparation;
        await producer;
        prepared.assertCurrent();
        expect(prepared.entry).toMatchObject(identity);
        expectPublication(childKey, childId);
        return;
      }
      const preparationOutcome = await withinTest(
        Promise.race([
          preparation.then((value) => {
            prepared = value;
            return "prepared" as const;
          }),
          preparationQueued.promise.then(() => "queued behind unrelated writer" as const),
        ]),
        signal,
      );
      expect(preparationOutcome).toBe("prepared");
      if (!prepared) {
        throw new Error("Cancellation preparation returned no retained session");
      }
      expect(prepared.entry).toMatchObject(identity);
      prepared.assertCurrent();
      let published = false;
      publication = operationScope.run("publication", () =>
        prepared!.withPublication(async () => {
          prepared!.assertCurrent();
          published = true;
        }),
      );
      await gate(publicationQueued.promise, publication, "Publication bypassed the writer FIFO");
      expect(published).toBe(false);
      release();
      await Promise.all([producer, publication]);
      expect(published).toBe(true);
      nativeClaim.assertCurrent();
      generationFacts!.assertCurrent();
      expectPublication(peerKey, peerId);
    } finally {
      release();
      await Promise.allSettled([producer, preparation, publication]);
      generationFacts?.release();
      await prepared?.release();
      await initial?.release();
      await execution?.release();
      signal.removeEventListener("abort", release);
      producerScope.disable();
      operationScope.disable();
    }
  },
);
