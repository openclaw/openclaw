import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { PendingFaceTimeDial } from "./outbound-call.js";

const PENDING_DIAL_KEY = "active";

type StoredPendingFaceTimeDial = Omit<PendingFaceTimeDial, "callUUIDAliases"> & {
  callUUIDAliases?: string[];
};

function decodePendingDial(
  value: StoredPendingFaceTimeDial | undefined,
): PendingFaceTimeDial | undefined {
  if (
    !value ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.ownerEpoch) ||
    value.ownerEpoch < 1 ||
    typeof value.dialID !== "string" ||
    typeof value.handle !== "string" ||
    (value.mode !== "audio" && value.mode !== "video") ||
    (value.delivery !== "in-flight" &&
      value.delivery !== "accepted" &&
      value.delivery !== "ambiguous" &&
      value.delivery !== "cancelling") ||
    typeof value.requestedAt !== "string"
  ) {
    return undefined;
  }
  const { callUUIDAliases, ...stored } = value;
  return {
    ...stored,
    ...(callUUIDAliases?.length ? { callUUIDAliases: new Set(callUUIDAliases) } : {}),
  };
}

export class PendingFaceTimeDialStore {
  #tail: Promise<void> = Promise.resolve();
  readonly #clearing = new Map<string, Promise<boolean>>();
  readonly #deleteMatching: (expectedDialID: string) => Promise<boolean>;

  constructor(private readonly store: PluginStateKeyedStore<StoredPendingFaceTimeDial>) {
    const { observe, compareAndApply, deleteIf } = store;
    if (observe && compareAndApply) {
      this.#deleteMatching = async (expectedDialID) => {
        let observation = await observe(PENDING_DIAL_KEY);
        for (;;) {
          const result = await compareAndApply(PENDING_DIAL_KEY, observation.comparison, {
            operation: "delete",
            action: observation.value?.dialID === expectedDialID ? "delete" : "keep",
          });
          if (result.status !== "conflict") {
            return result.status === "applied";
          }
          observation = result.current;
        }
      };
    } else if (deleteIf) {
      // Released 2026.9.4 hosts lack comparisons; never select this after a worker failure.
      this.#deleteMatching = (expectedDialID) =>
        deleteIf(PENDING_DIAL_KEY, (current) => current.dialID === expectedDialID);
    } else {
      throw new Error("FaceTime pending dial cleanup requires atomic plugin-state deletion");
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(operation);
    this.#tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  load(): Promise<PendingFaceTimeDial | undefined> {
    return this.#enqueue(async () => decodePendingDial(await this.store.lookup(PENDING_DIAL_KEY)));
  }

  save(pending: PendingFaceTimeDial): Promise<void> {
    const clearing = this.#clearing.get(pending.dialID);
    if (clearing) {
      return clearing.then(() => undefined);
    }
    const { callUUIDAliases, ...stored } = pending;
    // Capture the submitted state before waiting behind an earlier publication.
    const snapshot = {
      ...stored,
      ...(callUUIDAliases ? { callUUIDAliases: [...callUUIDAliases].toSorted() } : {}),
    };
    return this.#enqueue(() => this.store.register(PENDING_DIAL_KEY, snapshot));
  }

  clear(expectedDialID: string): Promise<boolean> {
    const existing = this.#clearing.get(expectedDialID);
    if (existing) {
      return existing;
    }
    const clearing = this.#enqueue(() => this.#deleteMatching(expectedDialID)).finally(() =>
      this.#clearing.delete(expectedDialID),
    );
    this.#clearing.set(expectedDialID, clearing);
    return clearing;
  }

  isClearing(dialID: string | undefined): boolean {
    return dialID !== undefined && this.#clearing.has(dialID);
  }

  settle(): Promise<void> {
    return this.#tail;
  }
}
