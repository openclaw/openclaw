import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { captureSessionTranscriptTargetBinding } from "../config/sessions/transcript-target-binding.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  createMediaGenerationOperation,
  findMediaGenerationOperation,
} from "./media-generation-activity.js";
import type { MediaGenerationTaskHandle } from "./tools/media-generate-background-completion.js";

/** Literal completion handles in transport tests still need real native admission. */
export function admitMediaHandle<
  T extends Omit<MediaGenerationTaskHandle, "detach"> & { detach?: boolean },
>(
  handle: T,
): T & {
  detach: boolean;
  requesterTranscript: NonNullable<MediaGenerationTaskHandle["requesterTranscript"]>;
} {
  if (!findMediaGenerationOperation(handle.runId)) {
    createMediaGenerationOperation({
      taskId: handle.taskId,
      runId: handle.runId,
      taskKind: "image_generation",
      requesterSessionKey: handle.requesterSessionKey,
      requesterAgentId: handle.requesterAgentId,
      task: handle.taskLabel,
      createdAt: Date.now(),
      status: "running",
    });
  }
  const agentId =
    handle.requesterAgentId ?? resolveAgentIdFromSessionKey(handle.requesterSessionKey);
  return {
    ...handle,
    detach: handle.detach ?? true,
    requesterTranscript: handle.requesterTranscript ?? {
      ...captureSessionTranscriptTargetBinding({
        agentId,
        sessionKey: handle.requesterSessionKey,
        sessionId: "media-requester",
        storePath: resolveSessionStorePathCore(undefined, { agentId }),
      }),
      lifecycleRevision: null,
    },
  };
}

/** Reset the existing owner's maps without replacing the shared singleton. */
export function resetGeneratedMediaTaskActivityForTests(): void {
  const state: unknown = Reflect.get(globalThis, Symbol.for("openclaw.mediaGenerationOperations"));
  if (!state || typeof state !== "object") {
    throw new Error("Media generation activity owner is not initialized");
  }
  for (const key of ["operations", "active", "admissions", "owners"] as const) {
    const value: unknown = Reflect.get(state, key);
    if (!(value instanceof Map)) {
      throw new Error(`Unexpected media generation activity fixture state: ${key}`);
    }
    value.clear();
  }
}
