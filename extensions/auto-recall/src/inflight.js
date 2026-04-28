/**
 * De-duplicate concurrent async work by key and clean up after settlement.
 */
export class InflightDeduper {
  constructor() {
    this.map = new Map();
  }

  run(key, fn) {
    if (this.map.has(key)) {
      return { promise: this.map.get(key), hit: true };
    }
    const promise = Promise.resolve()
      .then(fn)
      .finally(() => {
        this.map.delete(key);
      });
    this.map.set(key, promise);
    return { promise, hit: false };
  }

  size() {
    return this.map.size;
  }
}
