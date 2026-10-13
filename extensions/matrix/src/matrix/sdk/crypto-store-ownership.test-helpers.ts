import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fileLock from "openclaw/plugin-sdk/file-lock";
import { vi } from "vitest";

/** Observe real lock refusal while leaving custody and retry decisions to their owners. */
export function observeCryptoStoreContention(snapshotPath: string) {
  const observed = createDeferred<void>();
  const acquire = fileLock.acquireFileLock;
  const spy = vi.spyOn(fileLock, "acquireFileLock").mockImplementation(async (...args) => {
    try {
      return await acquire(...args);
    } catch (error) {
      if (
        args[0] === `${snapshotPath}.owner` &&
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === fileLock.FILE_LOCK_TIMEOUT_ERROR_CODE ||
          error.code === fileLock.FILE_LOCK_STALE_ERROR_CODE)
      ) {
        observed.resolve();
      }
      throw error;
    }
  });
  return {
    async waitFor(pending: Promise<unknown>) {
      await Promise.race([
        observed.promise,
        pending.then(
          () => {
            throw new Error("Contender completed before encountering the held lock");
          },
          (error: unknown) => {
            throw error;
          },
        ),
      ]);
    },
    close() {
      spy.mockRestore();
    },
  };
}
