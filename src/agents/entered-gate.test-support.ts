import { createDeferred } from "../../test/helpers/promise.js";

export function createEnteredGate() {
  const entered = createDeferred();
  const release = createDeferred();
  return {
    entered: entered.promise,
    release: release.resolve,
    wait: async () => {
      entered.resolve();
      await release.promise;
    },
  };
}
