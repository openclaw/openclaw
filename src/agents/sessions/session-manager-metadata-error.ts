import type { SessionTranscriptContextVersion } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import type { ModelChangeEntry, ThinkingLevelChangeEntry } from "./session-manager-types.js";

type MetadataTargetIdentity = {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
};

/** A known metadata append cannot be replayed when its local view or publication fails. */
export const SessionMetadataCommittedError = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionMetadataCommittedError"),
  () =>
    class CommittedMetadataError extends Error {
      readonly committedTarget?: MetadataTargetIdentity;
      constructor(
        readonly committedEntry: ModelChangeEntry | ThinkingLevelChangeEntry,
        readonly committedVersion: SessionTranscriptContextVersion | undefined,
        cause: unknown,
        target?: MetadataTargetIdentity,
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
            }
          : undefined;
        recordModelFallbackStop(this);
      }
    },
);
