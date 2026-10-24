// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../../config/config.js";
import { loadExactSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import * as preparedFacts from "../../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { prepareSessionGenerationFacts } from "../../../config/sessions/session-delivery-generation.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../../process/gateway-work-admission.js";
import { runOutsideAsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { OpenClawAgentDatabaseExecution } from "../../../state/openclaw-agent-execution-contract.js";
import * as executionOwner from "../../../state/openclaw-agent-execution.js";
import {
  prepareSubagentKillSession,
  type SubagentKillSession,
} from "./subagent-control-session.js";
import { holdControlSessionPublication } from "./subagent-control.fixtures.test-support.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();

beforeEach(() => {
  setRuntimeConfigSnapshot({ agents: { defaults: { workspace: fixture.stateDir } } });
});

it.for(["unrelated", "same session"] as const)(
  "prepares warm cancellation with a %s write while retaining publication ordering",
  async (writerTarget, { signal }) => {
    const childKey = "agent:main:subagent:warm-preparation";
    const childId = "warm-preparation-session";
    const revision = "warm-preparation-revision";
    const peerKey = "agent:main:subagent:unrelated-publication";
    const peerId = "unrelated-publication-session";
    const operationScope = new AsyncLocalStorage<"preparation" | "publication">();
    const preparationQueued = createDeferredCore();
    const publicationQueued = createDeferredCore();
    const generationPublicationPending = createDeferredCore();
    let heldPublication: ReturnType<typeof holdControlSessionPublication> | undefined;
    let initial: SubagentKillSession | undefined;
    let prepared: SubagentKillSession | undefined;
    let execution: OpenClawAgentDatabaseExecution | undefined;
    let generationFacts: Awaited<ReturnType<typeof prepareSessionGenerationFacts>> | undefined;
    let producer: Promise<void> | undefined;
    let preparation: Promise<SubagentKillSession> | undefined;
    let publication: Promise<void> | undefined;
    const release = () => heldPublication?.release();

    try {
      const storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: childKey,
        defaultSessionId: childId,
        lifecycleRevision: revision,
      });
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: peerKey,
        defaultSessionId: peerId,
      });
      const cfg = getRuntimeConfig();
      const writerKey = writerTarget === "unrelated" ? peerKey : childKey;
      const writerSessionId = writerTarget === "unrelated" ? peerId : childId;
      initial = await prepareSubagentKillSession(cfg, childKey, () => {}, undefined, "main", {
        sessionId: childId,
        lifecycleRevision: revision,
      });
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

      heldPublication = holdControlSessionPublication({
        signal,
        consumerScope: operationScope,
        reserveBeforeReply: false,
        onJoined: (observing) =>
          (observing === "preparation" ? preparationQueued : publicationQueued).resolve(),
      });
      const { producerScope, nativeHeld } = heldPublication;
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
      await withinTest(
        awaitGateBeforeSettlement(nativeHeld.promise, producer, "Writer publication was not held"),
        signal,
      );
      // Both the retained native incarnation and freshly read A facts are valid while B's
      // publication remains pending. A is not waiting for its own generation to settle.
      nativeClaim.assertCurrent();
      if (writerTarget === "unrelated") {
        initial.assertCurrent();
        generationFacts = await prepareSessionGenerationFacts({
          agentId: "main",
          storePath,
          sessionKey: childKey,
          sessionId: childId,
          lifecycleRevision: revision,
        });
        generationFacts.assertCurrent();
      }
      preparation = operationScope.run("preparation", () =>
        prepareSubagentKillSession(
          cfg,
          childKey,
          () => nativeClaim.assertCurrent(),
          undefined,
          "main",
          {
            sessionId: childId,
            lifecycleRevision: revision,
          },
        ),
      );
      if (writerTarget === "same session") {
        await withinTest(
          awaitGateBeforeSettlement(
            Promise.race([preparationQueued.promise, generationPublicationPending.promise]),
            preparation,
            "Preparation bypassed its own pending session publication",
          ),
          signal,
        );
        release();
        prepared = await preparation;
        await producer;
        prepared.assertCurrent();
        expect(prepared.entry).toMatchObject({ sessionId: childId, lifecycleRevision: revision });
        expect(
          loadExactSessionEntryReadOnly({ storePath, sessionKey: childKey })?.entry,
        ).toMatchObject({
          sessionId: childId,
          label: "held write published",
        });
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
      expect(prepared.entry).toMatchObject({ sessionId: childId, lifecycleRevision: revision });
      prepared.assertCurrent();
      let published = false;
      publication = operationScope.run("publication", () =>
        prepared!.withPublication(async () => {
          prepared!.assertCurrent();
          published = true;
        }),
      );
      await withinTest(
        awaitGateBeforeSettlement(
          publicationQueued.promise,
          publication,
          "Publication bypassed the writer FIFO",
        ),
        signal,
      );
      expect(published).toBe(false);
      release();
      await Promise.all([producer, publication]);
      expect(published).toBe(true);
      nativeClaim.assertCurrent();
      generationFacts!.assertCurrent();
      expect(
        loadExactSessionEntryReadOnly({ storePath, sessionKey: peerKey })?.entry,
      ).toMatchObject({
        sessionId: peerId,
        label: "held write published",
      });
    } finally {
      release();
      await Promise.allSettled([producer, preparation, publication]);
      generationFacts?.release();
      await prepared?.release();
      await initial?.release();
      await execution?.release();
      heldPublication?.dispose();
      operationScope.disable();
    }
  },
);
