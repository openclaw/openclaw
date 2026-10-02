import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { replaceSessionWithBranchedTranscript } from "../../config/sessions/session-accessor.js";
import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { publishCommittedSessionIdentity } from "../../config/sessions/session-accessor.sqlite-identity.js";
import { prepareSessionTranscriptHydration } from "../../config/sessions/session-transcript-hydration.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
} from "../../config/sessions/transcript-write-context.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import { parseOpaqueLeafEntry, parseParentLinkedOpaqueEntry } from "./session-manager-codec.js";
import { createManagedSessionId, generateSessionEntryId } from "./session-manager-id.js";
import { SessionManagerMetadata } from "./session-manager-metadata.js";
import type {
  LabelEntry,
  PreservedOpaqueFileEntry,
  SessionEntry,
  SessionHeader,
} from "./session-manager-types.js";
import type { SessionManagerPersistenceTarget } from "./session-manager-view-types.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";

export class SessionManagerBranching extends SessionManagerMetadata {
  private collectBranchedSessionPath(leafId: string): {
    entries: SessionEntry[];
    opaqueEntries: PreservedOpaqueFileEntry[];
    tailId: string | null;
  } {
    type BranchNode =
      | { type: "entry"; entry: SessionEntry }
      | { type: "opaque"; id: string; record: Record<string, unknown> };

    const opaqueById = new Map<string, Record<string, unknown>>();
    for (const opaqueEntry of this.opaqueFileEntries) {
      const leafEntry = parseOpaqueLeafEntry(opaqueEntry.record);
      const link = leafEntry ?? parseParentLinkedOpaqueEntry(opaqueEntry.record);
      if (link && isRecord(opaqueEntry.record)) {
        opaqueById.set(link.id, opaqueEntry.record);
      }
    }

    const reversedNodes: BranchNode[] = [];
    const seen = new Set<string>();
    let currentId: string | null = leafId;
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const entry = this.byId.get(currentId);
      if (entry) {
        reversedNodes.push({ type: "entry", entry });
        if (this.logicalParentsById.has(entry.id)) {
          let physicalId = entry.parentId;
          while (physicalId && !seen.has(physicalId)) {
            const physicalRecord = opaqueById.get(physicalId);
            if (!physicalRecord || !this.opaqueParentsById.has(physicalId)) {
              break;
            }
            seen.add(physicalId);
            reversedNodes.push({ type: "opaque", id: physicalId, record: physicalRecord });
            physicalId = this.opaqueParentsById.get(physicalId) ?? null;
          }
          currentId = this.logicalParentsById.get(entry.id) ?? null;
        } else {
          currentId = entry.parentId;
        }
        continue;
      }
      const record = opaqueById.get(currentId);
      if (!record || !this.opaqueParentsById.has(currentId)) {
        break;
      }
      reversedNodes.push({ type: "opaque", id: currentId, record });
      currentId = this.opaqueParentsById.get(currentId) ?? null;
    }

    const entries: SessionEntry[] = [];
    const opaqueEntries: PreservedOpaqueFileEntry[] = [];
    let tailId: string | null = null;
    for (const node of reversedNodes.toReversed()) {
      if (node.type === "entry") {
        if (node.entry.type === "label") {
          continue;
        }
        // This is the selected path in a new session, not an inactive side branch.
        // Its navigation controls are omitted, so copied entries must advance the leaf.
        const branchEntry: SessionEntry = { ...node.entry, parentId: tailId };
        delete branchEntry.appendMode;
        entries.push(branchEntry);
        tailId = branchEntry.id;
        continue;
      }
      if (parseOpaqueLeafEntry(node.record)) {
        continue;
      }
      opaqueEntries.push({
        index: entries.length + 1,
        record: { ...node.record, parentId: tailId },
      });
      tailId = node.id;
    }
    return { entries, opaqueEntries, tailId };
  }

  async createBranchedSession(leafId: string): Promise<string | undefined> {
    return withSessionManagerWrite(this, async (admission) => {
      this.assertTranscriptWriteActive();
      if (this.persistenceTarget && this.boundedContextIncomplete) {
        await this.ensureCompletePersistedHistoryAsync();
      }
      this.assertTranscriptWriteActive();
      const assertNavigation = this.captureTranscriptNavigationAssertion();
      const previousSessionId = this.sessionId;
      const branchPath = this.collectBranchedSessionPath(leafId);
      if (branchPath.entries.length === 0) {
        throw new Error(`Entry ${leafId} not found`);
      }

      const newSessionId = createManagedSessionId();
      const timestamp = new Date().toISOString();
      const persistenceTarget = this.persistenceTarget;

      const header: SessionHeader = {
        type: "session",
        version: this.getHeader()?.version,
        id: newSessionId,
        timestamp,
        cwd: this.cwd,
        parentSession: persistenceTarget ? previousSessionId : undefined,
      };
      const pathEntryIds = new Set(branchPath.entries.map((entry) => entry.id));
      const labelEntries: LabelEntry[] = [];
      let parentId = branchPath.tailId;
      for (const [targetId, label] of this.labelsById) {
        if (!pathEntryIds.has(targetId)) {
          continue;
        }
        const labelEntry: LabelEntry = {
          type: "label",
          id: generateSessionEntryId(),
          parentId,
          timestamp: this.labelTimestampsById.get(targetId)!,
          targetId,
          label,
        };
        labelEntries.push(labelEntry);
        parentId = labelEntry.id;
      }

      // Build leaf controls on a detached tree: queued or failed persistence must
      // never expose a new in-memory identity paired with the old durable target.
      const branch = new SessionManagerBranching(this.cwd, undefined, [
        header,
        ...branchPath.entries,
        ...labelEntries,
      ]);
      branch.opaqueFileEntries = branchPath.opaqueEntries;
      branch.buildIndex();
      const adoptBranch = (
        target?: SessionManagerPersistenceTarget,
        version?: SessionTranscriptContextVersion,
      ) => {
        this.fileEntries = branch.fileEntries;
        this.opaqueFileEntries = branch.opaqueFileEntries;
        this.sessionId = newSessionId;
        this.buildIndex();
        this.persistenceTarget = target;
        this.transcriptVersion = target ? version : undefined;
        this.transcriptMutationAt = target ? version?.updatedAt : undefined;
        this.persistenceHeaderPending = false;
      };
      if (persistenceTarget && admission && !isIncognitoSessionKey(persistenceTarget.sessionKey)) {
        const identity = { ...persistenceTarget };
        const version = this.transcriptVersion;
        const assertOwned = captureOwnedTranscriptWriteAssertion(identity);
        const assertDestinationOwned = captureOwnedTranscriptWriteAssertion({
          ...identity,
          sessionId: newSessionId,
        });
        const assertCurrent = () => {
          this.assertTranscriptWriteActive();
          assertOwned();
          assertNavigation();
          if (
            !sameSessionTranscriptTargetBinding(identity, this.persistenceTarget) ||
            this.transcriptVersion !== version
          ) {
            throw new Error("Session transcript changed during branch preparation");
          }
        };
        const { restoreSessionColdTranscript } =
          await import("../../config/sessions/session-cold-storage.js");
        await restoreSessionColdTranscript(persistenceTarget, assertCurrent);
        const reader = prepareSessionTranscriptHydration(persistenceTarget);
        const facts = await reader.readMaintenance({ operation: "version" });
        reader.assertCurrent();
        assertCurrent();
        const { withSessionMetadataWorker } = await import("./session-manager-metadata-runtime.js");
        assertCurrent();
        const fencedTarget = withOwnedSessionTranscriptWriterFence(persistenceTarget);
        const { env: _env, ...scope } = fencedTarget;
        const assertBranchCurrent = () => {
          assertCurrent();
          assertDestinationOwned();
        };
        const committed = await withSessionMetadataWorker(
          admission.options,
          admission.database,
          assertBranchCurrent,
          (worker) =>
            worker.execute({
              type: "session.transcript.branch",
              input: {
                scope: { ...scope, storePath: admission.database.path },
                branch: { sessionId: newSessionId, events: branch.getPersistedFileEntries() },
                expectedLifecycleRevision: facts.lifecycleRevision,
              },
            }),
        );
        if (committed.projectionNeedsReconcile) {
          startSessionTranscriptIndexReconcile({
            ...admission.options,
            preferredSessionId: newSessionId,
          });
        }
        let failure: { cause: unknown } | undefined;
        try {
          assertCurrent();
          adoptBranch({ ...fencedTarget, sessionId: newSessionId }, committed.version);
        } catch (cause) {
          failure = { cause };
        } finally {
          try {
            publishCommittedSessionIdentity(
              scope.agentId,
              readOpenClawAgentDatabaseIdentity(admission.database).identity,
              committed.identity.previous,
              committed.identity.current,
            );
          } catch (cause) {
            failure = {
              cause: failure
                ? new AggregateError(
                    [failure.cause, cause],
                    "Branch adoption and identity publication failed",
                    { cause: failure.cause },
                  )
                : cause,
            };
          }
        }
        if (failure) {
          const error = Object.assign(
            new Error(
              "Session branch committed, but publication did not complete; do not replay the branch",
              { cause: failure.cause },
            ),
            {
              name: "SessionBranchCommittedError",
              committedSessionId: newSessionId,
              committedTarget: { ...fencedTarget, sessionId: newSessionId },
              committedVersion: committed.version,
            },
          );
          recordModelFallbackStop(error);
          this.invalidateTranscriptView(error);
          throw error;
        }
      } else if (persistenceTarget) {
        // Incognito retains its process-held owner until its worker migration activates.
        await replaceSessionWithBranchedTranscript(
          persistenceTarget,
          { sessionId: newSessionId, events: branch.getPersistedFileEntries() },
          adoptBranch,
          () => {
            this.assertTranscriptWriteActive();
            assertNavigation();
          },
        );
      } else {
        adoptBranch();
      }
      return persistenceTarget ? newSessionId : undefined;
    });
  }
}
