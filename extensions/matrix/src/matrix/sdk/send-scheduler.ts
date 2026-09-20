import type { ISendEventResponse } from "matrix-js-sdk/lib/@types/requests.js";
import type { MatrixEvent } from "matrix-js-sdk/lib/models/event.js";
import { MatrixScheduler } from "matrix-js-sdk/lib/scheduler.js";
import { withoutMatrixSendCurrentness } from "./send-currentness.js";

type SendOutcome =
  | { kind: "sent"; result: ISendEventResponse }
  | { kind: "rejected"; error: unknown };

/** Keep SDK FIFO/backoff while settling a caller's pre-request rejection only for its event. */
export class MatrixSendScheduler extends MatrixScheduler {
  private readonly queue = new MatrixScheduler<SendOutcome>();

  constructor(private readonly wasCurrentnessRejected: (event: MatrixEvent) => boolean) {
    super();
  }

  override setProcessFunction(
    processEvent: (event: MatrixEvent) => Promise<ISendEventResponse>,
  ): void {
    this.queue.setProcessFunction(async (event) => {
      try {
        // Timeline requests obtain currentness from their own transaction guard.
        return {
          kind: "sent",
          result: await withoutMatrixSendCurrentness(() => processEvent(event)),
        };
      } catch (error) {
        if (!this.wasCurrentnessRejected(event)) {
          throw error;
        }
        // The SDK otherwise rejects every queued event on one terminal failure.
        return { kind: "rejected", error };
      }
    });
  }

  override queueEvent(event: MatrixEvent): Promise<ISendEventResponse> | null {
    const queued = this.queue.queueEvent(event);
    return queued
      ? queued.then((outcome) => {
          if (outcome.kind === "rejected") {
            throw outcome.error;
          }
          return outcome.result;
        })
      : null;
  }

  override getQueueForEvent(event: MatrixEvent): MatrixEvent[] | null {
    return this.queue.getQueueForEvent(event);
  }

  override removeEventFromQueue(event: MatrixEvent): boolean {
    return this.queue.removeEventFromQueue(event);
  }
}
