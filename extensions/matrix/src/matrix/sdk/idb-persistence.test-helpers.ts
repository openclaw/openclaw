export async function clearAllIndexedDbState(): Promise<void> {
  const databases = await indexedDB.databases();
  await Promise.all(
    databases
      .map((entry) => entry.name)
      .filter((name): name is string => Boolean(name))
      .map(
        (name) =>
          new Promise<void>((resolve, reject) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
            req.onblocked = () => resolve();
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
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(params.name, params.version ?? 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(params.storeName)) {
        db.createObjectStore(params.storeName);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(params.storeName, "readwrite");
      const store = tx.objectStore(params.storeName);
      for (const record of params.records) {
        store.put(record.value, record.key);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function readDatabaseRecords(params: {
  name: string;
  version?: number;
  storeName: string;
}): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  return await new Promise((resolve, reject) => {
    const req = indexedDB.open(params.name, params.version ?? 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(params.storeName, "readonly");
      const store = tx.objectStore(params.storeName);
      const keysReq = store.getAllKeys();
      const valuesReq = store.getAll();
      let keys: IDBValidKey[] | null = null;
      let values: unknown[] | null = null;

      const maybeResolve = () => {
        if (!keys || !values) {
          return;
        }
        db.close();
        const resolvedValues = values;
        resolve(keys.map((key, index) => ({ key, value: resolvedValues[index] })));
      };

      keysReq.onsuccess = () => {
        keys = keysReq.result;
        maybeResolve();
      };
      valuesReq.onsuccess = () => {
        values = valuesReq.result;
        maybeResolve();
      };
      keysReq.onerror = () => reject(keysReq.error);
      valuesReq.onerror = () => reject(valuesReq.error);
    };
    req.onerror = () => reject(req.error);
  });
}
