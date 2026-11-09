import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import type { SessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import type { ModelChangeEntry, ThinkingLevelChangeEntry } from "./session-manager-types.js";

/** A known metadata append cannot be replayed when its local view or publication fails. */
export const SessionMetadataCommittedError = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionMetadataCommittedError"),
  () =>
    class CommittedMetadataError extends Error {
      readonly committedTarget?: SessionTranscriptTargetBinding;
      constructor(
        readonly committedEntry: ModelChangeEntry | ThinkingLevelChangeEntry,
        readonly committedVersion: SessionTranscriptContextVersion | undefined,
        cause: unknown,
        target?: SessionTranscriptTargetBinding,
      ) {
        super(
          "Session metadata committed, but the operation did not complete; do not replay the append",
          { cause },
        );
        this.name = "SessionMetadataCommittedError";
        this.committedTarget = target
          ? {
              agentId: target.agentId,
              sessionId: target.sessionId,
              sessionKey: target.sessionKey,
              storePath: target.storePath,
              ...(target.env ? { env: { ...target.env } } : {}),
            }
          : undefined;
        recordModelFallbackStop(this);
      }
    },
);
