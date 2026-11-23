import { createRoot, createEffect, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { getLobsterdexEntries, recordLobsterVisit, subscribeLobsterdex } from "./lobster-dex.js";
import { observeSource } from "./observe.js";

afterEach(() => localStorage.clear());
it("projects local and cross-tab discoveries and retires both observers", () => {
  const changed = vi.fn();
  const dispose = createRoot((disposeRoot) => {
    const read = observeSource(getLobsterdexEntries, subscribeLobsterdex);
    createEffect(read, changed);
    return disposeRoot;
  });
  flush();
  changed.mockClear();
  recordLobsterVisit("synthetic-red", { name: "Red" });
  flush();
  expect(changed.mock.lastCall?.[0].get("synthetic-red")?.name).toBe("Red");
  localStorage.setItem(
    "openclaw.control.lobsterdex.v1",
    JSON.stringify({ "synthetic-blue": { name: "Blue" } }),
  );
  const storage = new StorageEvent("storage", { key: "openclaw.control.lobsterdex.v1" });
  Object.defineProperty(storage, "storageArea", { value: localStorage });
  window.dispatchEvent(storage);
  flush();
  expect(changed.mock.lastCall?.[0].get("synthetic-blue")?.name).toBe("Blue");
  dispose();
  changed.mockClear();
  recordLobsterVisit("synthetic-green");
  flush();
  expect(changed).not.toHaveBeenCalled();
});
