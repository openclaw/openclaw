import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import { capturePreparedModelRuntimeLifetime } from "./prepared-model-runtime.lifecycle.js";
import type { PreparedModelRuntimeStartup } from "./prepared-model-runtime.startup.js";
import type { PreparedModelRuntimeRefreshOptions } from "./prepared-model-runtime.types.js";

/** Publication scheduling may finish before acquisition; shutdown joins both. */
export class PreparedModelRuntimePublicationQueue {
  #tail: Promise<void> = Promise.resolve();
  readonly #pending = new Set<Promise<void>>();
  #latestRefresh: { completion: Promise<void>; isCurrent: () => boolean } | undefined;

  enqueue(task: () => Promise<void>, release?: Promise<void>): Promise<void> {
    const previous = this.#tail;
    const publication = previous.then(task);
    this.#pending.add(publication);
    const settled = () => {
      this.#pending.delete(publication);
    };
    void publication.then(settled, settled);
    this.#tail = (
      release ? previous.then(() => Promise.race([publication, release])) : publication
    ).then(
      () => undefined,
      () => undefined,
    );
    return publication;
  }

  complete(
    publication: Promise<void>,
    isCurrent: () => boolean,
    options: Pick<PreparedModelRuntimeRefreshOptions, "joinSupersedingPublication">,
    startup?: PreparedModelRuntimeStartup,
  ): Promise<void> {
    const assertLifetime = capturePreparedModelRuntimeLifetime();
    const refresh = { completion: publication, isCurrent };
    this.#latestRefresh = refresh;
    if (!options.joinSupersedingPublication) {
      return startup ? startup.wait(publication) : publication;
    }
    // Join outside the queue: the successor cannot run until this publication releases it.
    return (async () => {
      let current = refresh;
      for (;;) {
        assertLifetime();
        try {
          await current.completion;
        } catch (error) {
          if (
            !(error instanceof PreparedModelRuntimePublicationSupersededError) ||
            !this.#latestRefresh ||
            this.#latestRefresh === current
          ) {
            throw error;
          }
        }
        assertLifetime();
        if (this.#latestRefresh && this.#latestRefresh !== current) {
          current = this.#latestRefresh;
          continue;
        }
        if (!current.isCurrent()) {
          throw new PreparedModelRuntimePublicationSupersededError(
            "prepared model runtime publication was superseded without a current replacement refresh",
          );
        }
        return;
      }
    })();
  }

  async settle(): Promise<void> {
    this.#latestRefresh = undefined;
    await Promise.allSettled(this.#pending);
  }
}
