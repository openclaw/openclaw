import { indexedDB } from "fake-indexeddb";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    const fail = () => reject(toErrorObject(request.error, "Non-Error rejection"));
    request.addEventListener("error", fail, { once: true });
  });
}

export async function clearAllIndexedDbState(params?: { databasePrefix?: string }): Promise<void> {
  const databases = await indexedDB.databases();
  const expectedPrefix = params?.databasePrefix ? `${params.databasePrefix}::` : null;
  await Promise.all(
    databases
      .map((entry) => entry.name)
      .filter((name): name is string => Boolean(name))
      .filter((name) => !expectedPrefix || name.startsWith(expectedPrefix))
      .map(
        (name) =>
          new Promise<void>((resolve, reject) => {
            const req = indexedDB.deleteDatabase(name);
            void requestResult(req).then(() => resolve(), reject);
            req.addEventListener("blocked", () => resolve(), { once: true });
          }),
      ),
  );
}

export async function seedDatabase(params: {
  name: string;
  version?: number;
  storeName: string;
  records: Array<{ key: IDBValidKey; value: unknown }>;
}): Promise<void> {
  const req = indexedDB.open(params.name, params.version ?? 1);
  req.addEventListener("upgradeneeded", () => {
    if (!req.result.objectStoreNames.contains(params.storeName)) {
      req.result.createObjectStore(params.storeName);
    }
  });
  const db = await requestResult(req);
  const tx = db.transaction(params.storeName, "readwrite");
  for (const { key, value } of params.records) {
    tx.objectStore(params.storeName).put(value, key);
  }
  await new Promise<void>((resolve, reject) => {
    tx.addEventListener("complete", () => {
      db.close();
      resolve();
    });
    tx.addEventListener("error", () => reject(toErrorObject(tx.error, "Non-Error rejection")), {
      once: true,
    });
  });
}

export async function readDatabaseRecords(params: {
  name: string;
  version?: number;
  storeName: string;
}): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  const db = await requestResult(indexedDB.open(params.name, params.version ?? 1));
  const store = db.transaction(params.storeName, "readonly").objectStore(params.storeName);
  const [keys, values] = await Promise.all([
    requestResult(store.getAllKeys()),
    requestResult<unknown[]>(store.getAll()),
  ]);
  db.close();
  return keys.map((key, index) => ({ key, value: values[index] }));
}
