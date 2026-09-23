/** Serialize profile writers across Browser runtimes and Gateway processes. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { CONFIG_DIR } from "../utils.js";

const operationOwners = new AsyncLocalStorage<ReadonlyMap<string, string>>();

export async function withChromeProfileLifecycleLock<T>(
  profileName: string,
  run: () => Promise<T>,
): Promise<T> {
  // Reset moves user-data and deletion moves its profile directory. Neither
  // operation may move the transient lock that excludes another runtime.
  const target = path.join(CONFIG_DIR, "browser", `${profileName}.lifecycle`);
  const inherited = operationOwners.getStore();
  const owner = inherited?.get(target) ?? randomUUID();
  const owners = new Map(inherited);
  owners.set(target, owner);
  return await withFileLock(
    target,
    {
      retries: { retries: 600, factor: 1, minTimeout: 100, maxTimeout: 100 },
      stale: 60_000,
      staleRecovery: "remove-if-definitely-stale",
      // A transition calls stopOwned under this lock. The SDK retains live
      // ownership for that nested call; independent operations use unique keys.
      reentrantOwner: owner,
    },
    async () => await operationOwners.run(owners, run),
  );
}
