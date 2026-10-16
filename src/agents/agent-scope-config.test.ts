// Agent scope tests cover which per-agent fields may flatten into runtime defaults.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type {
  LegacyAgentListEntry,
  OpenClawConfigWithLegacyRoster,
} from "../config/legacy.roster.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import * as agentRoster from "./agent-roster.js";
import {
  AgentSelectionRequiredError,
  listAgentEntries,
  listAgentEntriesWithSource as entriesWithSource,
  listAgentIds,
  resolveConfiguredAgentId as configuredAgent,
  resolveAgentConfig as agentConfig,
  resolveAgentOperationAgentId as operationAgent,
  resolveAgentWorkspaceDir,
  resolveAmbientOwnerAgentId as ambientOwner,
  resolveDefaultAgentDir as defaultAgentDir,
  resolveDefaultAgentId as defaultAgent,
  resolveSoleAgentId as soleAgent,
  tryResolveAmbientOwnerAgentId as tryAmbientOwner,
  tryResolveAgentOperationAgentId as tryOperationAgent,
  tryResolveDefaultAgentId as tryDefaultAgent,
  tryResolveLegacyCompatibilityAgentId as compatibilityAgent,
  tryResolveLegacyDataOwnerAgentId as legacyOwner,
  tryResolveSoleAgentId as trySoleAgent,
  withAgentRosterFactsBatch,
} from "./agent-scope-config.js";

vi.unmock("./agent-scope-config.js");

function fleet(agents: NonNullable<OpenClawConfig["agents"]>): OpenClawConfig {
  return { agents };
}
const twoAgents = () => fleet({ entries: { main: {}, ops: {} } });
const legacy = (list?: LegacyAgentListEntry[]): OpenClawConfigWithLegacyRoster => ({
  agents: { list },
});

describe("agent roster resolution", () => {
  it("rejects unknown configured-agent selections with canonical CLI guidance", () => {
    const cfg = twoAgents();

    expect(configuredAgent(cfg, "ops")).toBe("ops");
    expect(() => configuredAgent(cfg, "nope-zzz")).toThrow(
      'Unknown agent id "nope-zzz". Run openclaw agents list to see configured agents.',
    );
  });

  it("keeps the guidance runnable under a profile", () => {
    const cfg = twoAgents();
    vi.stubEnv("OPENCLAW_PROFILE", "testprof");
    try {
      expect(() => configuredAgent(cfg, "nope-zzz")).toThrow(
        "Run openclaw --profile testprof agents list to see configured agents.",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("preserves the Plugin SDK fallback only when the roster property is absent", () => {
    expect(listAgentIds({})).toEqual(["main"]);
    expect(listAgentIds({ agents: { entries: {} } })).toEqual([]);
    expect(defaultAgent({})).toBe("main");
    expect(defaultAgent(legacy())).toBe("main");
    expect(defaultAgent({ agents: { defaults: { workspace: "/srv/main" } } })).toBe("main");
    expect(() => defaultAgent({ agents: { entries: {} } })).toThrow("No agents configured");
    expect(() => defaultAgent(legacy([]))).toThrow("No agents configured");
  });

  it("preserves raw legacy markers while sole-agent lookup stays strict", () => {
    expect(soleAgent({ agents: { entries: { alpha: {} } } })).toBe("alpha");
    expect(trySoleAgent({ agents: { entries: { alpha: {} } } })).toBe("alpha");
    const missingDefault = legacy([{ id: "alpha" }, { id: "beta" }]);
    expect(() => defaultAgent(missingDefault)).toThrow(AgentSelectionRequiredError);
    expect(tryDefaultAgent(missingDefault)).toBeUndefined();
    const markedDefault = legacy([{ id: "alpha" }, { id: "beta", default: true }]);
    expect(defaultAgent(markedDefault)).toBe("beta");
    const duplicateDefaults = legacy([
      { id: "alpha", default: true },
      { id: "beta", default: true },
    ]);
    expect(() => defaultAgent(duplicateDefaults)).toThrow(AgentSelectionRequiredError);
    expect(tryDefaultAgent(duplicateDefaults)).toBeUndefined();
  });

  it("reads only enough own enumerable entries to distinguish a sole mutable agent", () => {
    const entries: Record<string, unknown> = Object.create({ inherited: {} });
    Object.defineProperty(entries, "hidden", { value: {} });
    entries[" OPS "] = { name: "Ops" };
    entries.other = {};
    const tail = vi.fn(() => ({ name: "Tail" }));
    Object.defineProperty(entries, "tail", { enumerable: true, configurable: true, get: tail });
    const cfg = { agents: { ownership: "explicit" as const, entries } };
    expect(trySoleAgent(cfg)).toBeUndefined();
    expect(tail).not.toHaveBeenCalled();
    expect(entriesWithSource(cfg)).toEqual([
      { entry: { id: " OPS ", name: "Ops" }, source: { kind: "entries", key: " OPS " } },
      { entry: { id: "other" }, source: { kind: "entries", key: "other" } },
      { entry: { id: "tail", name: "Tail" }, source: { kind: "entries", key: "tail" } },
    ]);
    expect(tail).toHaveBeenCalledTimes(1);
    delete entries.other;
    delete entries.tail;
    expect(trySoleAgent(cfg)).toBe("ops");
    delete entries[" OPS "];
    expect(trySoleAgent(cfg)).toBeUndefined();
  });

  it("preserves sparse legacy list objects, arrays, and source indices", () => {
    const first = { id: " OPS " };
    const arrayEntry = Object.assign([], { id: "array" });
    const list: unknown[] = [];
    const inherited = { id: "inherited" };
    const prototype = Object.create(Array.prototype);
    prototype[2] = inherited;
    Object.setPrototypeOf(list, prototype);
    list[1] = null;
    list[3] = first;
    list[5] = arrayEntry;
    const tail = vi.fn(() => ({ id: "tail" }));
    Object.defineProperty(list, 7, { configurable: true, get: tail });
    const cfg = { agents: { list } };
    expect(trySoleAgent(cfg)).toBeUndefined();
    expect(tail).not.toHaveBeenCalled();
    expect(entriesWithSource(cfg)).toEqual([
      { entry: inherited, source: { kind: "list", index: 2 } },
      { entry: first, source: { kind: "list", index: 3 } },
      { entry: arrayEntry, source: { kind: "list", index: 5 } },
      { entry: { id: "tail" }, source: { kind: "list", index: 7 } },
    ]);
    expect(tail).toHaveBeenCalledTimes(1);
    expect(listAgentEntries(cfg)[1]).toBe(first);
    expect(listAgentEntries(cfg)[2]).toBe(arrayEntry);
    list.length = 4;
    delete prototype[2];
    expect(trySoleAgent(cfg)).toBe("ops");
  });

  it("fails closed with context when an ambient owner is ambiguous", () => {
    const ownerlessFleet = {
      agents: { ownership: "explicit" as const, entries: { ops: {}, research: {} } },
    } satisfies OpenClawConfig;

    retainLegacyDefaultAgentId(ownerlessFleet, "ops");
    expect(tryAmbientOwner(ownerlessFleet)).toBeUndefined();
    expect(() => ambientOwner(ownerlessFleet)).toThrow(AgentSelectionRequiredError);
    const resolveWithContext = () =>
      ambientOwner(ownerlessFleet, undefined, {
        surface: "Talk relay ownership",
        hint: "Set talk.agentId.",
      });
    expect(resolveWithContext).toThrow("Talk relay ownership");
    expect(resolveWithContext).toThrow("Set talk.agentId.");
  });

  it("resolves the default agent directory through the ambient owner", () => {
    const config = fleet({
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "beta" } },
      entries: { alpha: {}, beta: { agentDir: "/tmp/openclaw-beta-agent" } },
    });

    expect(defaultAgentDir(config)).toBe(path.resolve("/tmp/openclaw-beta-agent"));
  });

  it("uses the recorded explicit owner ahead of migration provenance and retired markers", () => {
    const migrated = createCanonicalAgentConfigFixture({
      agents: {
        defaults: { systemAgent: { agentId: "research" } },
        entries: { ops: { default: true }, research: {} },
      },
    }).config;
    migrated.agents!.ownership = "explicit";
    for (const config of [migrated, structuredClone(migrated)]) {
      expect(compatibilityAgent(config)).toBe("research");
      expect(operationAgent(config)).toBe("research");
      expect(ambientOwner(config)).toBe("research");
      expect(tryDefaultAgent(config)).toBeUndefined();
    }
  });

  it("does not infer an explicit fleet owner from a retired marker", () => {
    const config: OpenClawConfigWithLegacyRoster = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "deleted" } },
        entries: { ops: { default: true }, research: {} },
      },
    };
    retainLegacyDefaultAgentId(config, "ops");
    expect(compatibilityAgent(config)).toBeUndefined();
    expect(tryOperationAgent(config)).toBeUndefined();
  });

  it("prefers a per-agent toolProgressDetail over the roster default", () => {
    const defaults = { toolProgressDetail: "explain" as const };
    const entries = { main: { toolProgressDetail: "raw" as const } };

    expect(agentConfig({ agents: { defaults, entries } }, "main")?.toolProgressDetail).toBe("raw");
    expect(agentConfig({ agents: { entries } }, "main")?.toolProgressDetail).toBe("raw");
    expect(
      agentConfig({ agents: { defaults, entries: { main: {} } } }, "main")?.toolProgressDetail,
    ).toBe("explain");
  });

  it("resolves defaults only for the rosterless implicit main agent", () => {
    const defaults = { fastModeDefault: "auto" as const };
    const emptyLegacyRoster: OpenClawConfigWithLegacyRoster = { agents: { defaults, list: [] } };

    expect(agentConfig({ agents: { defaults } }, "main")?.fastModeDefault).toBe("auto");
    expect(agentConfig({ agents: { defaults } }, "work")).toBeUndefined();
    expect(agentConfig({ agents: { defaults, entries: {} } }, "main")).toBeUndefined();
    expect(agentConfig(emptyLegacyRoster, "main")).toBeUndefined();
  });

  it("does not project unrelated keyed entries while resolving one agent", () => {
    let unrelatedEntryReads = 0;
    const entries = new Proxy(
      { main: { name: "Primary" }, worker: { name: "Worker" } },
      {
        get(target, property, receiver) {
          if (property === "worker") {
            unrelatedEntryReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const config = { agents: { ownership: "explicit" as const, entries } };

    expect(agentConfig(config, "main")?.name).toBe("Primary");
    expect(unrelatedEntryReads).toBe(0);
  });

  it("prepares one published fleet roster per generation", () => {
    const previous = getRuntimeConfigSnapshot();
    const source = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "agent-0" } },
        entries: Object.fromEntries(
          Array.from({ length: 200 }, (_, index) => [`agent-${index}`, { name: `${index}` }]),
        ),
      },
    };
    setRuntimeConfigSnapshot(source);
    const entries = vi.spyOn(agentRoster, "listAgentEntriesWithSource");
    const ids = vi.spyOn(agentRoster, "listAgentIds");
    try {
      for (let index = 0; index < 200; index += 1) {
        withAgentRosterFactsBatch(source, () => {
          expect(agentConfig(source, `agent-${index}`)?.name).toBe(`${index}`);
          expect(compatibilityAgent(source)).toBe("agent-0");
        });
      }
      // One point-lookup index and one configured-owner membership projection.
      expect(entries.mock.calls.length + ids.mock.calls.length).toBeLessThanOrEqual(2);
      source.agents.entries["agent-0"]!.name = "Replacement";
      source.agents.defaults.systemAgent.agentId = "agent-199";
      setRuntimeConfigSnapshot(source);
      expect(agentConfig(source, "agent-0")?.name).toBe("Replacement");
      expect(compatibilityAgent(source)).toBe("agent-199");
      clearRuntimeConfigSnapshot();
      source.agents.entries["agent-0"]!.name = "Unbound";
      expect(agentConfig(source, "agent-0")?.name).toBe("Unbound");
    } finally {
      entries.mockRestore();
      ids.mockRestore();
      if (previous) {
        setRuntimeConfigSnapshot(previous);
      } else {
        clearRuntimeConfigSnapshot();
      }
    }
  });

  it("does not treat Doctor migration provenance as runtime ownership", () => {
    const config = captureRuntimeConfig({ agents: { entries: { ops: {}, research: {} } } });
    for (const owner of ["ops", "research", undefined]) {
      retainLegacyDefaultAgentId(config, owner);
      expect(legacyOwner(config)).toBeUndefined();
    }
  });

  it("reads mutations below a shallow-frozen roster owner", () => {
    const config = Object.freeze({ agents: { entries: { ops: { name: "before" } } } });
    expect(agentConfig(config, "ops")?.name).toBe("before");
    config.agents.entries.ops.name = "after";
    expect(agentConfig(config, "ops")?.name).toBe("after");
  });

  it("keeps the implicit default workspace inside an overridden state directory", () => {
    const stateDir = "/srv/openclaw-scratch";

    expect(
      resolveAgentWorkspaceDir({}, "main", {
        HOME: "/home/operator",
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toBe(path.resolve(stateDir, "workspace"));
  });

  it("copies own __proto__ fields without changing the listed entry prototype", () => {
    const entry = JSON.parse('{"__proto__":{"tools":{"allow":["*"]}}}') as Record<string, unknown>;
    const cfg = { agents: { entries: { ops: entry } } };
    const [listed] = entriesWithSource(cfg);
    expect(listed).toBeDefined();
    const [plainEntry] = listAgentEntries(cfg);
    expect(plainEntry).toBeDefined();

    for (const listedEntry of [listed!.entry, plainEntry!]) {
      expect(Object.getPrototypeOf(listedEntry)).toBe(Object.prototype);
      expect(Object.hasOwn(listedEntry, "__proto__")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(listedEntry, "__proto__")?.value).toEqual({
        tools: { allow: ["*"] },
      });
      expect(listedEntry.tools).toBeUndefined();
    }
  });
});

describe("agentConfig model policy", () => {
  it("returns an explicit per-agent allowlist override", () => {
    const cfg = fleet({
      defaults: { modelPolicy: { allow: ["openai/gpt-5.5"] } },
      entries: { main: { modelPolicy: { allow: ["openai/gpt-5.6-sol"] } } },
    });

    expect(agentConfig(cfg, "main")?.modelPolicy).toEqual({
      allow: ["openai/gpt-5.6-sol"],
    });
  });
});
