import type { Slot, Task } from "./worker-task-pool.types.js";

/** A failed bootstrap stops new construction until its generation is rotated. */
export function createWorkerTaskPoolBootstrap<Input, Output>(
  slots: ReadonlySet<Slot<Input, Output>>,
  queue: Task<Input, Output>[],
  reject: (task: Task<Input, Output>, error: Error) => void,
) {
  let failure: Error | undefined;
  const admissionError = () =>
    failure &&
    ![...slots].some((slot) => slot.ready === true && !slot.retiring && !slot.retirementFailed)
      ? failure
      : undefined;
  const rejectQueued = () => {
    const error = admissionError();
    if (!error) {
      return;
    }
    // Detach the whole cohort before callbacks can reenter admission or dispatch.
    const queued = queue.splice(0);
    for (const task of queued) {
      reject(task, error);
    }
  };
  return {
    error: () => failure,
    get admissionError() {
      return admissionError();
    },
    fail(error: Error) {
      failure ??= error;
      rejectQueued();
    },
    rejectQueued,
    reset: () => {
      failure = undefined;
    },
  };
}
