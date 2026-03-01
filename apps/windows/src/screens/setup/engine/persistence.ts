import { Store } from "@tauri-apps/plugin-store";
import { Snapshot } from "xstate";

// Reuse a single Store instance to avoid repeated disk open calls.
let store: Store | null = null;

async function getStore() {
  if (!store) {
    try {
      store = await Store.load("setup.json");
    } catch (e) {
      console.warn("Store.load failed", e);
    }
  }
  return store;
}

export async function saveState(snapshot: Snapshot<unknown>) {
  if (!snapshot) return;
  try {
    const s = await getStore();
    if (s) {
      await s.set("machineSnapshot", snapshot);
      await s.save();
    }
  } catch (e) {
    console.error("Failed to save setup state", e);
  }
}

export async function loadState(): Promise<Snapshot<unknown> | undefined> {
  try {
    const s = await getStore();
    if (s) {
      return (await s.get("machineSnapshot")) as Snapshot<unknown>;
    }
  } catch (e) {
    console.error("Failed to load setup state", e);
  }
  return undefined;
}

export async function clearState() {
  try {
    const s = await getStore();
    if (s) {
      await s.delete("machineSnapshot");
      await s.save();
    }
  } catch (e) {
    console.error("Failed to clear setup state", e);
  }
}
