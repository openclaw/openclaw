import { describe, expect, it } from "vitest";
import { CopilotPanelBindingRegistry, CopilotSessionRegistry } from "./copilot-session-registry.js";

function storageArea(initial: Record<string, unknown> = {}) {
  const values = { ...initial };
  const setCalls: Record<string, unknown>[] = [];
  return {
    setCalls,
    values,
    async get(keys: string[]) {
      return Object.fromEntries(keys.map((key) => [key, values[key]]));
    },
    async set(update: Record<string, unknown>) {
      setCalls.push(update);
      Object.assign(values, update);
    },
  };
}

function storage(localInitial: Record<string, unknown> = {}, sessionInitial = {}) {
  return { local: storageArea(localInitial), session: storageArea(sessionInitial) };
}

describe("CopilotSessionRegistry", () => {
  it("archives prior-browser and missing-tab sessions during recovery", async () => {
    const mock = storage(
      {
        copilotSessionRegistryV1: {
          sessions: {
            1: { browserInstanceId: "old", sessionKey: "session-old", sessionId: "id-old" },
            2: {
              browserInstanceId: "current",
              sessionKey: "session-closed",
              sessionId: "id-closed",
            },
            3: { browserInstanceId: "current", sessionKey: "session-live", sessionId: "id-live" },
          },
          pendingArchives: [],
        },
      },
      { copilotBrowserInstanceV1: "current" },
    );
    const registry = new CopilotSessionRegistry(mock as never);

    await registry.initialize(new Set([1, 3]));

    expect(registry.get(1)).toBeNull();
    expect(registry.get(2)).toBeNull();
    expect(registry.get(3)?.sessionKey).toBe("session-live");
    expect(registry.pendingArchives().map((entry) => entry.sessionKey)).toEqual([
      "session-old",
      "session-closed",
    ]);
  });

  it("moves a closed tab to the durable archive queue exactly once", async () => {
    const mock = storage();
    const registry = new CopilotSessionRegistry(mock as never);
    await registry.initialize(new Set([8]));
    await registry.put(8, { sessionKey: "session-8", sessionId: "id-8" });

    await registry.closeTab(8);
    await registry.closeTab(8);

    expect(registry.get(8)).toBeNull();
    expect(registry.pendingArchives()).toHaveLength(1);
    await registry.resolveArchive("session-8");
    expect(registry.pendingArchives()).toEqual([]);
  });
});

describe("CopilotPanelBindingRegistry", () => {
  it("mints one browser-instance capability per tab and removes it on close", async () => {
    const area = storageArea();
    const bindings = new CopilotPanelBindingRegistry(area as never);

    const [first, second] = await Promise.all([bindings.bind(7), bindings.bind(7)]);

    expect(first).toBe(second);
    expect(area.setCalls).toHaveLength(1);
    await expect(bindings.bind(7)).resolves.toBe(first);
    expect(area.setCalls).toHaveLength(1);
    await expect(bindings.resolve(first)).resolves.toBe(7);
    await bindings.remove(7);
    await expect(bindings.resolve(first)).resolves.toBeNull();
  });
});
