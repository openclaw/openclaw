/** Serialize profile writers across Browser runtimes and Gateway processes. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { CONFIG_DIR } from "openclaw/plugin-sdk/text-utility-runtime";
import { withProfileFilesystemLock } from "../../profile-filesystem.js";

// Reentrancy for nested lifecycle calls; read only on launch/stop/cleanup await chains.
const operationOwners = new AsyncLocalStorage<ReadonlyMap<string, string>>();

export async function withChromeProfileLifecycleLock<T>(
  profileName: string,
  run: () => Promise<T>,
): Promise<T> {
  // Reset moves user-data and deletion moves its profile directory. Neither
  // operation may move the transient lock that excludes another runtime.
  const target = path.join(CONFIG_DIR, "browser", `${profileName}.lifecycle`);
  const inherited = operationOwners.getStore();
  if (inherited?.has(target)) {
    return await run();
  }
  const owner = randomUUID();
  const owners = new Map(inherited);
  owners.set(target, owner);
  return await withProfileFilesystemLock(
    target,
    owner,
    async () => await operationOwners.run(owners, run),
  );
}
