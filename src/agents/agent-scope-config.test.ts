// Agent scope tests cover which per-agent fields may flatten into runtime defaults.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfigWithLegacyRoster } from "../config/legacy.roster.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import * as agentRoster from "./agent-roster.js";
import {
  AgentSelectionRequiredError,
  listAgentEntries,
  listAgentEntriesWithSource,
  listAgentIds,
  resolveConfiguredAgentId,
  resolveAgentConfig,
  resolveAgentOperationAgentId,
  resolveAgentWorkspaceDir,
  resolveAmbientOwnerAgentId,
  resolveDefaultAgentDir,
  resolveDefaultAgentId,
  resolveSoleAgentId,
  tryResolveAmbientOwnerAgentId,
  tryResolveAgentOperationAgentId,
  tryResolveDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId,
  tryResolveLegacyDataOwnerAgentId,
  tryResolveSoleAgentId,
  withAgentRosterFactsBatch,
} from "./agent-scope-config.js";

vi.unmock("./agent-scope-config.js");

describe("agent roster resolution", () => {
  it("rejects unknown configured-agent selections with canonical CLI guidance", () => {
    const cfg = { agents: { entries: { main: {}, ops: {} } } };

    expect(resolveConfiguredAgentId(cfg, "ops")).toBe("ops");
    expect(() => resolveConfiguredAgentId(cfg, "nope-zzz")).toThrow(
      'Unknown agent id "nope-zzz". Run openclaw agents list to see configured agents.',
    );
  });

  it("keeps the guidance runnable under a profile", () => {
    const cfg = { agents: { entries: { main: {}, ops: {} } } };
    const previous = process.env.OPENCLAW_PROFILE;
    process.env.OPENCLAW_PROFILE = "testprof";
    try {
      // A hint the operator cannot paste back is worse than none, so the profile must survive.
      expect(() => resolveConfiguredAgentId(cfg, "nope-zzz")).toThrow(
        "Run openclaw --profile testprof agents list to see configured agents.",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_PROFILE;
      } else {
        process.env.OPENCLAW_PROFILE = previous;
      }
    }
  });

  it("preserves the Plugin SDK fallback only when the roster property is absent", () => {
    const absentLegacyRoster: OpenClawConfigWithLegacyRoster = { agents: { list: undefined } };
    const emptyLegacyRoster: OpenClawConfigWithLegacyRoster = { agents: { list: [] } };
    expect(listAgentIds({})).toEqual(["main"]);
    expect(listAgentIds({ agents: { entries: {} } })).toEqual([]);
    expect(resolveDefaultAgentId({})).toBe("main");
    expect(resolveDefaultAgentId(absentLegacyRoster)).toBe("main");
    expect(resolveDefaultAgentId({ agents: { defaults: { workspace: "/srv/main" } } })).toBe(
      "main",
    );
    expect(() => resolveDefaultAgentId({ agents: { entries: {} } })).toThrow(
      "No agents configured",
    );
    expect(() => resolveDefaultAgentId(emptyLegacyRoster)).toThrow("No agents configured");
  });

  it("preserves raw legacy markers while sole-agent lookup stays strict", () => {
    expect(resolveSoleAgentId({ agents: { entries: { alpha: {} } } })).toBe("alpha");
    expect(tryResolveSoleAgentId({ agents: { entries: { alpha: {} } } })).toBe("alpha");
    const missingDefault: OpenClawConfigWithLegacyRoster = {
      agents: { list: [{ id: "alpha" }, { id: "beta" }] },
    };
    expect(() => resolveDefaultAgentId(missingDefault)).toThrow(AgentSelectionRequiredError);
    expect(tryResolveDefaultAgentId(missingDefault)).toBeUndefined();
    const markedDefault: OpenClawConfigWithLegacyRoster = {
      agents: { list: [{ id: "alpha" }, { id: "beta", default: true }] },
    };
    expect(resolveDefaultAgentId(markedDefault)).toBe("beta");
    const duplicateDefaults: OpenClawConfigWithLegacyRoster = {
      agents: {
        list: [
          { id: "alpha", default: true },
          { id: "beta", default: true },
        ],
      },
    };
    expect(() => resolveDefaultAgentId(duplicateDefaults)).toThrow(AgentSelectionRequiredError);
    expect(tryResolveDefaultAgentId(duplicateDefaults)).toBeUndefined();
  });

  it("reads only enough own enumerable entries to distinguish a sole mutable agent", () => {
    const entries: Record<string, unknown> = Object.create({ inherited: {} });
    Object.defineProperty(entries, "hidden", { value: {} });
    entries[" OPS "] = { name: "Ops" };
    entries.other = {};
    const tail = vi.fn(() => ({ name: "Tail" }));
    Object.defineProperty(entries, "tail", { enumerable: true, configurable: true, get: tail });
    const cfg = { agents: { ownership: "explicit" as const, entries } };
    expect(tryResolveSoleAgentId(cfg)).toBeUndefined();
    expect(tail).not.toHaveBeenCalled();
    expect(listAgentEntriesWithSource(cfg)).toEqual([
      { entry: { id: " OPS ", name: "Ops" }, source: { kind: "entries", key: " OPS " } },
      { entry: { id: "other" }, source: { kind: "entries", key: "other" } },
      { entry: { id: "tail", name: "Tail" }, source: { kind: "entries", key: "tail" } },
    ]);
    expect(tail).toHaveBeenCalledTimes(1);
    delete entries.other;
    delete entries.tail;
    expect(tryResolveSoleAgentId(cfg)).toBe("ops");
    delete entries[" OPS "];
    expect(tryResolveSoleAgentId(cfg)).toBeUndefined();
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
    expect(tryResolveSoleAgentId(cfg)).toBeUndefined();
    expect(tail).not.toHaveBeenCalled();
    expect(listAgentEntriesWithSource(cfg)).toEqual([
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
    expect(tryResolveSoleAgentId(cfg)).toBe("ops");
  });

  it("fails closed with context when an ambient owner is ambiguous", () => {
    const ownerlessFleet = {
      agents: { ownership: "explicit" as const, entries: { ops: {}, research: {} } },
    } satisfies OpenClawConfig;

    retainLegacyDefaultAgentId(ownerlessFleet, "ops");
    expect(tryResolveAmbientOwnerAgentId(ownerlessFleet)).toBeUndefined();
    expect(() => resolveAmbientOwnerAgentId(ownerlessFleet)).toThrow(AgentSelectionRequiredError);
    expect(() =>
      resolveAmbientOwnerAgentId(ownerlessFleet, undefined, {
        surface: "Talk relay ownership",
        hint: "Set talk.agentId.",
      }),
    ).toThrow("Talk relay ownership");
    expect(() =>
      resolveAmbientOwnerAgentId(ownerlessFleet, undefined, {
        surface: "Talk relay ownership",
        hint: "Set talk.agentId.",
      }),
    ).toThrow("Set talk.agentId.");
  });

  it("resolves the default agent directory through the ambient owner", () => {
    const config = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "beta" } },
        entries: { alpha: {}, beta: { agentDir: "/tmp/openclaw-beta-agent" } },
      },
    } satisfies OpenClawConfig;

    expect(resolveDefaultAgentDir(config)).toBe(path.resolve("/tmp/openclaw-beta-agent"));
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
      expect(tryResolveLegacyCompatibilityAgentId(config)).toBe("research");
      expect(resolveAgentOperationAgentId(config)).toBe("research");
      expect(resolveAmbientOwnerAgentId(config)).toBe("research");
      expect(tryResolveDefaultAgentId(config)).toBeUndefined();
    }
  });

  it.each(["deleted"])(
    "does not infer an explicit fleet owner from a retired marker with designation %s",
    (agentId) => {
      const config: OpenClawConfigWithLegacyRoster = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId } },
          entries: { ops: { default: true }, research: {} },
        },
      };
      retainLegacyDefaultAgentId(config, "ops");
      expect(tryResolveLegacyCompatibilityAgentId(config)).toBeUndefined();
      expect(tryResolveAgentOperationAgentId(config)).toBeUndefined();
    },
  );

  it("prefers a per-agent toolProgressDetail over the roster default", () => {
    const defaults = { toolProgressDetail: "explain" as const };
    const entries = { main: { toolProgressDetail: "raw" as const } };

    expect(resolveAgentConfig({ agents: { defaults, entries } }, "main")?.toolProgressDetail).toBe(
      "raw",
    );
    expect(resolveAgentConfig({ agents: { entries } }, "main")?.toolProgressDetail).toBe("raw");
    expect(
      resolveAgentConfig({ agents: { defaults, entries: { main: {} } } }, "main")
        ?.toolProgressDetail,
    ).toBe("explain");
  });

  it("resolves defaults only for the rosterless implicit main agent", () => {
    const defaults = { fastModeDefault: "auto" as const };
    const emptyLegacyRoster: OpenClawConfigWithLegacyRoster = { agents: { defaults, list: [] } };

    expect(resolveAgentConfig({ agents: { defaults } }, "main")?.fastModeDefault).toBe("auto");
    expect(resolveAgentConfig({ agents: { defaults } }, "work")).toBeUndefined();
    expect(resolveAgentConfig({ agents: { defaults, entries: {} } }, "main")).toBeUndefined();
    expect(resolveAgentConfig(emptyLegacyRoster, "main")).toBeUndefined();
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

    expect(resolveAgentConfig(config, "main")?.name).toBe("Primary");
    expect(unrelatedEntryReads).toBe(0);
  });

  it("prepares one immutable fleet roster", () => {
    const config = captureRuntimeConfig({
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "agent-0" } },
        entries: Object.fromEntries(
          Array.from({ length: 200 }, (_, index) => [`agent-${index}`, { name: `${index}` }]),
        ),
      },
    });
    const entries = vi.spyOn(agentRoster, "listAgentEntriesWithSource");
    const ids = vi.spyOn(agentRoster, "listAgentIds");
    try {
      for (let index = 0; index < 200; index += 1) {
        withAgentRosterFactsBatch(config, () => {
          expect(resolveAgentConfig(config, `agent-${index}`)?.name).toBe(`${index}`);
          expect(tryResolveLegacyCompatibilityAgentId(config)).toBe("agent-0");
        });
      }
      // One point-lookup index and one configured-owner membership projection.
      expect(entries.mock.calls.length + ids.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      entries.mockRestore();
      ids.mockRestore();
    }
  });

  it("does not treat Doctor migration provenance as runtime ownership", () => {
    const config = captureRuntimeConfig({ agents: { entries: { ops: {}, research: {} } } });
    retainLegacyDefaultAgentId(config, "ops");
    expect(tryResolveLegacyDataOwnerAgentId(config)).toBeUndefined();
    retainLegacyDefaultAgentId(config, "research");
    expect(tryResolveLegacyDataOwnerAgentId(config)).toBeUndefined();
    retainLegacyDefaultAgentId(config, undefined);
    expect(tryResolveLegacyDataOwnerAgentId(config)).toBeUndefined();
  });

  it("reads mutations below a shallow-frozen roster owner", () => {
    const config = Object.freeze({ agents: { entries: { ops: { name: "before" } } } });
    expect(resolveAgentConfig(config, "ops")?.name).toBe("before");
    config.agents.entries.ops.name = "after";
    expect(resolveAgentConfig(config, "ops")?.name).toBe("after");
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
    const cfg = {
      agents: { entries: { ops: entry } },
    };
    const [listed] = listAgentEntriesWithSource(cfg);
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

describe("resolveAgentConfig model policy", () => {
  it("returns an explicit per-agent allowlist override", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        entries: { main: { modelPolicy: { allow: ["openai/gpt-5.6-sol"] } } },
      },
    };

    expect(resolveAgentConfig(cfg, "main")?.modelPolicy).toEqual({
      allow: ["openai/gpt-5.6-sol"],
    });
  });
});
