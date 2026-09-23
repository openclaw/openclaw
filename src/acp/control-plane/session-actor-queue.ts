import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";

type ActorLane = {
  id: number;
  queue: KeyedAsyncQueue;
  users: number;
  retired: boolean;
};

/** Serializes each current actor lane without retaining a history of retired lanes. */
export class SessionActorQueue {
  private readonly lanes = new Map<string, ActorLane>();
  private nextLaneId = 0;
  private pendingCount = 0;

  getTotalPendingCount(): number {
    return this.pendingCount;
  }

  /** Holds a generation until the caller releases its cleanup/operation custody. */
  capture(actorKey: string) {
    let lane = this.lanes.get(actorKey);
    if (!lane) {
      lane = { id: ++this.nextLaneId, queue: new KeyedAsyncQueue(), users: 0, retired: false };
      this.lanes.set(actorKey, lane);
    }
    const captured = lane;
    captured.users += 1;
    let released = false;
    return {
      id: captured.id,
      queue: captured.queue,
      isCurrent: () => !released && !captured.retired,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        captured.users -= 1;
        if (captured.users === 0 && this.lanes.get(actorKey) === captured) {
          this.lanes.delete(actorKey);
        }
      },
    };
  }

  async run<T>(actorKey: string, op: (isCurrent: () => boolean) => Promise<T>): Promise<T> {
    const captured = this.capture(actorKey);
    try {
      return await captured.queue.enqueue(
        `${actorKey}\u0000${captured.id}`,
        async () => {
          if (!captured.isCurrent()) {
            throw new Error(`ACP session actor was superseded for ${actorKey}.`);
          }
          return await op(captured.isCurrent);
        },
        {
          onEnqueue: () => {
            this.pendingCount += 1;
          },
          onSettle: () => {
            this.pendingCount -= 1;
          },
        },
      );
    } finally {
      captured.release();
    }
  }

  /** Fresh work bypasses a stuck lane; only outstanding operations retain the retired token. */
  rotate(actorKey: string): void {
    const lane = this.lanes.get(actorKey);
    if (lane) {
      lane.retired = true;
      this.lanes.delete(actorKey);
    }
  }
}
