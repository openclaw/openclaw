import { vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as stateReads from "../../../state/openclaw-state-db-readonly.js";

export function holdFirstCompactRead(
  command = "subagents.sessionList",
  scopeKind?: "session",
  failure?: Error,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const execute = stateReads.executeExistingOpenClawStateRead;
  let held = false;
  const read = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementation(async (...args) => {
      const result = await execute(...args);
      if (
        args[1].type === command &&
        !held &&
        (scopeKind === undefined ||
          (args[1].type === "subagents.runs" && args[1].scope.kind === scopeKind))
      ) {
        held = true;
        entered.resolve();
        await release.promise;
        if (failure) {
          throw failure;
        }
      }
      return result;
    });
  return {
    entered: entered.promise,
    release: release.resolve,
    read,
    async during<T>(reading: Promise<T>, change: () => void) {
      try {
        await entered.promise;
        change();
        release.resolve();
        return await reading;
      } finally {
        release.resolve();
        await reading.catch(() => {});
      }
    },
  };
}
