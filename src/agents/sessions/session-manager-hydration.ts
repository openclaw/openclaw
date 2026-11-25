import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { SessionEntryCohortRequest } from "../../config/sessions/session-entry-read.types.js";
import { sessionStoreLane } from "../../config/sessions/session-transcript-worker-resources.js";
import {
  captureSessionTranscriptTargetBinding,
  sameSessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import {
  SessionManagerCore,
  sessionManagerReloadTranscriptCohort,
} from "./session-manager-core.js";
import { installSessionManagerIncognitoBinding } from "./session-manager-incognito-scope.js";
import { prepareSessionManagerHydration } from "./session-manager-incognito.js";
import { consumeSessionManagerReload } from "./session-manager-reload.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerTranscriptCohort,
} from "./session-manager-view-types.js";

/**
 * Host-side hydration through the transcript reader. This module reaches the reader runtime and
 * cold-storage restoration. The reader worker constructs SessionManagerCore directly and must
 * never import this module: its private build would re-emit the host graph as its own chunks.
 */
export class SessionManagerHydration extends SessionManagerCore {
  /** Prepare off-thread and publish the entire view only while this manager is unchanged. */
  async setSessionTargetAsync(
    target: SessionTranscriptRuntimeTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.hydrateSessionTarget(target, false, signal);
  }

  private async hydrateSessionTarget(
    target: SessionTranscriptRuntimeTarget,
    preserveCwd: boolean,
    signal?: AbortSignal,
    complete = false,
    cohort?: SessionManagerTranscriptCohort,
  ): Promise<boolean> {
    this.assertTranscriptViewAvailable();
    const capturedTarget = captureSessionTranscriptTargetBinding(target);
    const hydration = prepareSessionManagerHydration(capturedTarget, {
      caller: complete ? "model-complete" : "model-reload",
      limits: complete ? undefined : this.boundedContextLimits,
      signal,
      manager: this,
      retarget:
        !preserveCwd && !sameSessionTranscriptTargetBinding(capturedTarget, this.persistenceTarget),
      lane: preserveCwd ? sessionStoreLane : undefined,
    });
    if (cohort && !hydration.readCohort) {
      return false;
    }
    const assertOwned = captureOwnedTranscriptWriteAssertion(hydration.target);
    const revision = ++this.hydrationRevision;
    const prior = this.captureTranscriptView();
    const entryCount = this.fileEntries.length;
    const opaqueCount = this.opaqueFileEntries.length;
    assertOwned();
    const publish = (prepared: PreparedSessionTranscriptReload) => {
      signal?.throwIfAborted();
      assertOwned();
      hydration.assertCurrent();
      const current = this.captureTranscriptView();
      if (
        revision !== this.hydrationRevision ||
        this.fileEntries.length !== entryCount ||
        this.opaqueFileEntries.length !== opaqueCount ||
        Object.keys(prior).some((key) => Reflect.get(prior, key) !== Reflect.get(current, key))
      ) {
        throw new Error("Session manager changed during transcript hydration");
      }
      this.adoptPreparedTranscriptReload(prepared, undefined, hydration.target);
      installSessionManagerIncognitoBinding(this, hydration.incognitoBinding);
      if (!preserveCwd) {
        this.cwd = this.fileEntries.find((entry) => entry.type === "session")?.cwd ?? this.cwd;
      }
      this.hydrationRevision++;
      consumeSessionManagerReload(
        prepared,
        cohort?.consume,
        () => this.captureTranscriptView(),
        () => {
          assertOwned();
          hydration.assertCurrent();
        },
      );
    };
    if (cohort && hydration.readCohort) {
      await hydration.readCohort(cohort.selection, publish);
    } else {
      publish(
        await hydration.read().catch((error: unknown) => {
          assertOwned();
          throw error;
        }),
      );
    }
    return true;
  }

  [sessionManagerReloadTranscriptCohort](
    selection: NonNullable<SessionEntryCohortRequest["transcript"]>,
    consume: (prepared: PreparedSessionTranscriptReload, assertView: () => void) => void,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.persistenceTarget && this.boundedContextLimits
      ? this.hydrateSessionTarget(this.persistenceTarget, true, signal, false, {
          selection,
          consume,
        })
      : Promise.resolve(false);
  }

  /** Reload an existing view without changing the runtime working directory. */
  async reloadPersistedTranscriptAsync(signal?: AbortSignal): Promise<void> {
    if (!this.persistenceTarget) {
      return;
    }
    await this.hydrateSessionTarget(this.persistenceTarget, true, signal);
  }

  protected async ensureCompletePersistedHistoryAsync(): Promise<void> {
    this.assertTranscriptViewAvailable();
    if (this.persistenceTarget && this.boundedContextIncomplete) {
      await this.hydrateSessionTarget(this.persistenceTarget, true, undefined, true);
    }
  }
}
