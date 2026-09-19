/** Publication scheduling may finish before acquisition; shutdown joins both. */
export class PreparedModelRuntimePublicationQueue {
  #tail: Promise<void> = Promise.resolve();
  readonly #pending = new Set<Promise<void>>();

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

  async settle(): Promise<void> {
    await Promise.allSettled(this.#pending);
  }
}
