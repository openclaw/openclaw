import type { WorkerTranscriptCommitRequestFrame } from "./schema/worker-admission.js";
import { isWorkerFrameWithinBudget } from "./schema/worker-protocol-primitives.js";

export function isWorkerTranscriptFrameWithinBudget(
  frame: WorkerTranscriptCommitRequestFrame,
): boolean {
  return isWorkerFrameWithinBudget(frame, () =>
    frame.params.messages.flatMap(({ content }) =>
      typeof content === "string"
        ? []
        : content.flatMap((part) => (part.type === "image" ? [part.data] : [])),
    ),
  );
}
