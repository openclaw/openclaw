import "fake-indexeddb/auto";
import { indexedDB as snapshotFactory } from "fake-indexeddb";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { requestResult } from "./idb-persistence.test-helpers.js";
import { beginMatrixSdkIndexedDbSession } from "./indexeddb-session.js";

const databases = new Set<string>();
async function open(factory: IDBFactory, name: string, version = 1): Promise<IDBDatabase> {
  databases.add(name);
  const request = factory.open(name, version);
  request.addEventListener("upgradeneeded", () => request.result.createObjectStore("keys"));
  return await requestResult(request);
}

async function fixture(label: string) {
  const prefix = `matrix-session-${label}`;
  const name = `${prefix}::matrix-sdk-crypto`;
  const session = beginMatrixSdkIndexedDbSession(prefix);
  return { prefix, name, session, connection: await open(globalThis.indexedDB, name) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const name of databases) {
    await requestResult(snapshotFactory.deleteDatabase(name));
  }
  databases.clear();
});

it("admits a successor through a fresh module while captured generation cleanup stays retired", async () => {
  const { prefix, name, session: first, connection } = await fixture("reloaded-module");
  await first.retire();
  vi.resetModules();
  const next = (await import("./indexeddb-session.js")).beginMatrixSdkIndexedDbSession(prefix);
  const successor = await open(globalThis.indexedDB, name);
  await first.retire();
  expect(() => successor.transaction("keys")).not.toThrow();
  expect(() => connection.transaction("keys")).toThrow();
  await next.retire();
});

it("settles writes and rejects old connections while allowing snapshot export and another account", async () => {
  const { name, session, connection } = await fixture("write");
  connection.transaction("keys", "readwrite").objectStore("keys").put("saved", "key");
  await session.retire();
  expect(() => connection.transaction("keys", "readwrite")).toThrow();
  expect(() => globalThis.indexedDB.open(name)).toThrow();
  const snapshot = await open(snapshotFactory, name);
  const request = snapshot.transaction("keys").objectStore("keys").get("key");
  expect(await requestResult(request)).toBe("saved");
  snapshot.close();
  const other = await fixture("write-other");
  await other.session.retire();
  const next = await fixture("write");
  expect(() => connection.transaction("keys")).toThrow();
  await next.session.retire();
});

it("joins a blocked open and aborts its late upgrade before permitting a successor", async () => {
  const prefix = "matrix-session-blocked";
  const name = `${prefix}::matrix-sdk-crypto`;
  const blocker = await open(snapshotFactory, name);
  const session = beginMatrixSdkIndexedDbSession(prefix);
  const blocked = createDeferred<void>();
  const request = globalThis.indexedDB.open(name, 2);
  request.addEventListener("blocked", () => blocked.resolve());
  const outcome = expect(requestResult(request)).rejects.toMatchObject({ name: "AbortError" });
  await blocked.promise;
  const retirement = session.retire();
  expect(() => beginMatrixSdkIndexedDbSession(prefix)).toThrow();
  expect(() => globalThis.indexedDB.open(name)).toThrow();
  blocker.close();
  await retirement;
  await outcome;
  const snapshot = await open(snapshotFactory, name);
  expect(snapshot.version).toBe(1);
  snapshot.close();
  await beginMatrixSdkIndexedDbSession(prefix).retire();
});

it("keeps failed connection retirement closed and refuses a replacement generation", async () => {
  const { prefix, session, connection } = await fixture("failed-close");
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
