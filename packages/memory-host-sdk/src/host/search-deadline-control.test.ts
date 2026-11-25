import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { describe, expect, it, vi } from "vitest";
import {
  buildPluginLoaderAliasMap,
  buildPluginLoaderJitiOptions,
} from "../../../../src/plugins/sdk-alias.js";
import { createMemorySearchDeadlineControl } from "./search-deadline-control.js";

describe("createMemorySearchDeadlineControl", () => {
  it("shares the legacy memory channel with embedding providers through the SDK loader", async () => {
    const entry = fileURLToPath(new URL("../../../../extensions/ollama/index.ts", import.meta.url));
    const aliases = buildPluginLoaderAliasMap(entry, undefined, import.meta.url, "src");
    const load = createJiti(import.meta.url, buildPluginLoaderJitiOptions(aliases));
    const embedding = await load.import<
      typeof import("../../../../src/plugin-sdk/embedding-providers.js")
    >("openclaw/plugin-sdk/embedding-providers");
    const memory = await load.import<
      typeof import("../../../../src/plugin-sdk/memory-core-host-engine-storage.js")
    >("openclaw/plugin-sdk/memory-core-host-engine-storage");
    expect(memory.MEMORY_SEARCH_DEADLINE_CONTROL).toBe(embedding.EMBEDDING_DEADLINE_CONTROL);
    const control = memory.createMemorySearchDeadlineControl();
    const options = { [memory.MEMORY_SEARCH_DEADLINE_CONTROL]: control };
    const listener = vi.fn();
    control.subscribe(listener);
    options[embedding.EMBEDDING_DEADLINE_CONTROL].report("pause");
    options[embedding.EMBEDDING_DEADLINE_CONTROL].report("resume");
    expect(listener.mock.calls).toEqual([["pause"], ["resume"]]);
  });

  it("balances overlapping owned phases so one resume cannot re-arm early", () => {
    const control = createMemorySearchDeadlineControl();
    const events: string[] = [];
    control.subscribe((action) => events.push(action));
    control.report("pause");
    control.report("pause");
    control.report("resume");
    expect(events).toEqual(["pause"]);
    control.report("resume");
    expect(events).toEqual(["pause", "resume"]);
  });

  it("ignores resume reports without a matching pause", () => {
    const control = createMemorySearchDeadlineControl();
    const listener = vi.fn();
    control.subscribe(listener);
    control.report("resume");
    expect(listener).not.toHaveBeenCalled();
  });

  it("replays the active pause to a subscriber that attaches mid-phase", () => {
    const control = createMemorySearchDeadlineControl();
    control.report("pause");
    const events: string[] = [];
    control.subscribe((action) => events.push(action));
    expect(events).toEqual(["pause"]);
    control.report("resume");
    expect(events).toEqual(["pause", "resume"]);
  });

  it("stops notifying after unsubscribe", () => {
    const control = createMemorySearchDeadlineControl();
    const listener = vi.fn();
    const unsubscribe = control.subscribe(listener);
    unsubscribe();
    control.report("pause");
    expect(listener).not.toHaveBeenCalled();
  });
});
