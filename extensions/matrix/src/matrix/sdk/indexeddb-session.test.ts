import "fake-indexeddb/auto";
import { indexedDB as snapshotFactory } from "fake-indexeddb";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginMatrixSdkIndexedDbSession } from "./indexeddb-session.js";

const databases = new Set<string>();
async function open(factory: IDBFactory, name: string, version = 1): Promise<IDBDatabase> {
  databases.add(name);
  return await new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.addEventListener("upgradeneeded", () => request.result.createObjectStore("keys"));
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(toErrorObject(request.error, "IndexedDB request failed")),
    );
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const name of databases) {
    await new Promise<void>((resolve, reject) => {
      const request = snapshotFactory.deleteDatabase(name);
      request.addEventListener("success", () => resolve());
      request.addEventListener("error", () =>
        reject(toErrorObject(request.error, "IndexedDB request failed")),
      );
    });
  }
  databases.clear();
});

describe("Matrix SDK IndexedDB session retirement", () => {
  it("admits a successor through a fresh module while captured generation cleanup stays retired", async () => {
    const prefix = "matrix-session-reloaded-module";
    const first = beginMatrixSdkIndexedDbSession(prefix);
    const name = `${prefix}::matrix-sdk-crypto`;
    const connection = await open(globalThis.indexedDB, name);
    await first.retire();
    vi.resetModules();
    const freshModule = await import("./indexeddb-session.js");
    const next = freshModule.beginMatrixSdkIndexedDbSession(prefix);
    const successor = await open(globalThis.indexedDB, name);
    await first.retire();
    expect(() => successor.transaction("keys")).not.toThrow();
    expect(() => connection.transaction("keys")).toThrow();
    successor.close();
    await next.retire();
  });

  it("settles writes and rejects old connections while allowing snapshot export and another account", async () => {
    const prefix = "matrix-session-write";
    const session = beginMatrixSdkIndexedDbSession(prefix);
    const name = `${prefix}::matrix-sdk-crypto`;
    const connection = await open(globalThis.indexedDB, name);
    const transaction = connection.transaction("keys", "readwrite");
    transaction.objectStore("keys").put("saved", "key");
    await session.retire();
    expect(() => connection.transaction("keys", "readwrite")).toThrow();
    expect(() => globalThis.indexedDB.open(name)).toThrow();
    const snapshot = await open(snapshotFactory, name);
    const request = snapshot.transaction("keys").objectStore("keys").get("key");
    const saved = await new Promise((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () =>
        reject(toErrorObject(request.error, "IndexedDB request failed")),
      );
    });
    expect(saved).toBe("saved");
    snapshot.close();
    const other = beginMatrixSdkIndexedDbSession(`${prefix}-other`);
    const unrelated = await open(globalThis.indexedDB, `${prefix}-other::matrix-sdk-crypto`);
    unrelated.close();
    await other.retire();
    const next = beginMatrixSdkIndexedDbSession(prefix);
    const successor = await open(globalThis.indexedDB, name);
    expect(() => connection.transaction("keys")).toThrow();
    successor.close();
    await next.retire();
  });

  it("joins a blocked open and aborts its late upgrade before permitting a successor", async () => {
    const prefix = "matrix-session-blocked";
    const name = `${prefix}::matrix-sdk-crypto`;
    const blocker = await open(snapshotFactory, name);
    const session = beginMatrixSdkIndexedDbSession(prefix);
    const blocked = createDeferred<void>();
    const request = globalThis.indexedDB.open(name, 2);
    request.addEventListener("blocked", () => blocked.resolve());
    const outcome = new Promise((resolve) => {
      request.addEventListener("error", () => resolve(request.error?.name));
      request.addEventListener("success", () => resolve("unexpected success"));
    });
    await blocked.promise;
    const retirement = session.retire();
    expect(() => beginMatrixSdkIndexedDbSession(prefix)).toThrow();
    expect(() => globalThis.indexedDB.open(name)).toThrow();
    blocker.close();
    await retirement;
    expect(await outcome).toBe("AbortError");
    const snapshot = await open(snapshotFactory, name);
    expect(snapshot.version).toBe(1);
    snapshot.close();
    await beginMatrixSdkIndexedDbSession(prefix).retire();
  });

  it("keeps failed connection retirement closed and refuses a replacement generation", async () => {
    const prefix = "matrix-session-failed-close";
    const session = beginMatrixSdkIndexedDbSession(prefix);
    const name = `${prefix}::matrix-sdk-crypto`;
    const connection = await open(globalThis.indexedDB, name);
    const close = connection.close.bind(connection);
    vi.spyOn(connection, "close").mockImplementation(() => {
      throw new Error("simulated close failure");
    });
    await expect(session.retire()).rejects.toThrow("simulated close failure");
    await expect(session.retire()).rejects.toThrow("simulated close failure");
    expect(() => beginMatrixSdkIndexedDbSession(prefix)).toThrow();
    expect(() => connection.transaction("keys", "readwrite")).toThrow();
    close();
  });
});
