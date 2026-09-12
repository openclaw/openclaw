// Agent scope tests cover which per-agent fields may flatten into runtime defaults.
import { describe, expect, it, vi } from "vitest";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  AgentSelectionRequiredError,
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
  tryResolveDefaultAgentId,
  tryResolveDiscoveryDefaultAgentId,
  tryResolveLegacyCompatibilityAgentId,
  tryResolveSoleAgentId,
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
    expect(listAgentIds({})).toEqual(["main"]);
    expect(listAgentIds({ agents: { entries: {} } })).toEqual([]);
    expect(resolveDefaultAgentId({})).toBe("main");
    expect(resolveDefaultAgentId({ agents: { list: undefined } })).toBe("main");
    expect(resolveDefaultAgentId({ agents: { defaults: { workspace: "/srv/main" } } })).toBe(
      "main",
    );
    expect(() => resolveDefaultAgentId({ agents: { entries: {} } })).toThrow(
      "No agents configured",
    );
    expect(() => resolveDefaultAgentId({ agents: { list: [] } })).toThrow("No agents configured");
  });

  it("preserves raw legacy markers while sole-agent lookup stays strict", () => {
    expect(resolveSoleAgentId({ agents: { entries: { alpha: {} } } })).toBe("alpha");
    expect(tryResolveSoleAgentId({ agents: { entries: { alpha: {} } } })).toBe("alpha");
    const missingDefault = { agents: { list: [{ id: "alpha" }, { id: "beta" }] } };
    expect(() => resolveDefaultAgentId(missingDefault)).toThrow(AgentSelectionRequiredError);
    expect(tryResolveDefaultAgentId(missingDefault)).toBeUndefined();
    expect(
      resolveDefaultAgentId({
        agents: { list: [{ id: "alpha" }, { id: "beta", default: true }] },
      }),
    ).toBe("beta");
    const duplicateDefaults = {
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

  it("keeps the generic selection hint free of surface-specific assumptions", () => {
    expect(() => resolveDefaultAgentId({ agents: { entries: { alpha: {}, beta: {} } } })).toThrow(
      "Multiple agents are configured, but this operation has no explicit owner. Select an agent explicitly; CLI callers can pass --agent <id>, channels can add a binding, and ambient services can set their agentId target.",
    );
  });

  const ambientOwnerCases: Array<{
    name: string;
    config: OpenClawConfig;
    requestedAgentId?: string;
    expected: string;
  }> = [
    {
      name: "configured system agent before a legacy marker",
      config: {
        agents: {
          defaults: { systemAgent: { agentId: "beta" } },
          entries: { alpha: { default: true }, beta: {} },
        },
      } satisfies OpenClawConfig,
      expected: "beta",
    },
    {
      name: "configured system agent before a retained migrated legacy owner",
      config: migratePersistedImplicitMainRoster({
        agents: {
          defaults: { systemAgent: { agentId: "beta" } },
          entries: { alpha: { default: true }, beta: {} },
        },
      }).config as OpenClawConfig,
      expected: "beta",
    },
    {
      name: "legacy marker without a configured system agent",
      config: {
        agents: { entries: { alpha: { default: true }, beta: {} } },
      } satisfies OpenClawConfig,
      expected: "alpha",
    },
    {
      name: "sole agent",
      config: { agents: { entries: { solo: {} } } } satisfies OpenClawConfig,
      expected: "solo",
    },
    {
      name: "explicit requested agent before every configured owner",
      config: {
        agents: {
          defaults: { systemAgent: { agentId: "beta" } },
          entries: { alpha: { default: true }, beta: {}, gamma: {} },
        },
      } satisfies OpenClawConfig,
      requestedAgentId: " GAMMA ",
      expected: "gamma",
    },
  ];

  it.each(ambientOwnerCases)(
    "resolves ambient owner: $name",
    ({ config, requestedAgentId, expected }) => {
      expect(tryResolveAmbientOwnerAgentId(config, requestedAgentId)).toBe(expected);
      expect(resolveAmbientOwnerAgentId(config, requestedAgentId)).toBe(expected);
    },
  );

  it("fails closed with context when an ambient owner is ambiguous", () => {
    const ownerlessFleet = {
      agents: { ownership: "explicit" as const, entries: { ops: {}, research: {} } },
    } satisfies OpenClawConfig;

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

  it("recovers the persisted legacy default for discovery surfaces through systemAgent", () => {
    // Doctor persists multi-agent upgrades with explicit ownership while materializing
    // the retired default agent's surfaces into agents.defaults.systemAgent. After restart
    // the process-only retained id is gone, so the discovery default must recover the
    // same principal from the persisted assignment (regression: `openclaw agents list
    // --json` reported isDefault=false for every agent and legacy integrations got
    // "default agent not detected").
    const persistedFleet = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;

    expect(tryResolveDiscoveryDefaultAgentId(persistedFleet)).toBe("ops");
  });

  it("keeps strict compatibility resolution ownerless in explicit fleets", () => {
    // Strict ownership resolution must keep failing closed even when a system agent is
    // configured; only discovery projections may treat the system agent as the default.
    const ownerlessFleet = {
      agents: { ownership: "explicit" as const, entries: { ops: {}, research: {} } },
    } satisfies OpenClawConfig;
    expect(tryResolveLegacyCompatibilityAgentId(ownerlessFleet)).toBeUndefined();
    expect(tryResolveDiscoveryDefaultAgentId(ownerlessFleet)).toBeUndefined();

    const configuredSystemAgent = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;
    expect(tryResolveLegacyCompatibilityAgentId(configuredSystemAgent)).toBeUndefined();

    const staleSystemAgent = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "retired-agent" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;
    expect(tryResolveDiscoveryDefaultAgentId(staleSystemAgent)).toBeUndefined();

    const blankSystemAgent = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "  " } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;
    expect(tryResolveDiscoveryDefaultAgentId(blankSystemAgent)).toBeUndefined();
  });

  it("keeps a raw legacy default marker ahead of the configured system agent", () => {
    const config = {
      agents: {
        defaults: { systemAgent: { agentId: "beta" } },
        entries: { alpha: { default: true }, beta: {} },
      },
    } satisfies OpenClawConfig;

    expect(tryResolveLegacyCompatibilityAgentId(config)).toBe("alpha");
    expect(tryResolveDiscoveryDefaultAgentId(config)).toBe("alpha");
  });

  it("resolves the discovery default across a persisted multi-agent upgrade restart", () => {
    // Mirror doctor-config-flow's persistence: migrate a legacy list with one default
    // marker, then drop the process-only migration sidecar (structuredClone) and stamp
    // explicit ownership exactly as the persisted on-disk config looks after restart.
    const rawConfig = {
      agents: {
        list: [
          { id: "ops", default: true, workspace: "/srv/ops" },
          { id: "research", model: "openai/research" },
        ],
      },
    };
    const migrated = migratePersistedImplicitMainRoster(rawConfig, {
      materializeWorkspace: true,
    }).config as OpenClawConfig;
    expect(migrated.agents?.defaults?.systemAgent?.agentId).toBe("ops");

    const persisted = structuredClone(migrated);
    persisted.agents = { ...persisted.agents, ownership: "explicit" as const };
    expect(persisted.agents?.entries?.ops).not.toHaveProperty("default");
    expect(tryResolveLegacyCompatibilityAgentId(persisted)).toBeUndefined();
    expect(tryResolveDiscoveryDefaultAgentId(persisted)).toBe("ops");
  });

  it("resolves the default agent directory through the ambient owner", () => {
    const config = {
      agents: {
        defaults: { systemAgent: { agentId: "beta" } },
        entries: { alpha: { default: true }, beta: { agentDir: "/tmp/openclaw-beta-agent" } },
      },
    } satisfies OpenClawConfig;

    expect(resolveDefaultAgentDir(config)).toBe("/tmp/openclaw-beta-agent");
  });

  it("preserves legacy default ownership for non-explicit CLI operations", () => {
    const config = {
      agents: {
        entries: { main: {}, ops: { default: true } },
      },
    };

    expect(resolveAgentOperationAgentId(config)).toBe("ops");
    expect(
      resolveAgentOperationAgentId({
        ...config,
        agents: {
          ...config.agents,
          ownership: "explicit" as const,
          defaults: { systemAgent: { agentId: "main" } },
        },
      }),
    ).toBe("main");
  });

  it("preserves retained legacy ownership for migrated CLI operations", () => {
    const cfg = migratePersistedImplicitMainRoster({
      agents: {
        entries: { ops: { default: true }, research: {} },
      },
    }).config as OpenClawConfig;

    expect(cfg.agents?.entries?.ops?.default).toBeUndefined();
    expect(resolveAgentOperationAgentId(cfg)).toBe("ops");
  });

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

    expect(resolveAgentConfig({ agents: { defaults } }, "main")?.fastModeDefault).toBe("auto");
    expect(resolveAgentConfig({ agents: { defaults } }, "work")).toBeUndefined();
    expect(resolveAgentConfig({ agents: { defaults, entries: {} } }, "main")).toBeUndefined();
    expect(resolveAgentConfig({ agents: { defaults, list: [] } }, "main")).toBeUndefined();
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

  it("keeps the retained legacy owner on the inherited workspace before config write", () => {
    const cfg = migratePersistedImplicitMainRoster({
      agents: {
        defaults: { workspace: "/srv/ops" },
        entries: { ops: { default: true }, research: {} },
      },
    }).config as OpenClawConfig;

    expect(cfg.agents?.entries?.ops?.default).toBeUndefined();
    expect(cfg.agents?.entries?.ops?.workspace).toBeUndefined();
    expect(resolveAgentWorkspaceDir(cfg, "ops")).toBe("/srv/ops");
    expect(resolveAgentWorkspaceDir(cfg, "research")).toBe("/srv/ops/research");
  });

  it("keeps a raw legacy marker owner on the inherited workspace", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/srv/ops" },
        entries: { ops: { default: true }, research: {} },
      },
    };

    expect(resolveAgentWorkspaceDir(cfg, "ops")).toBe("/srv/ops");
    expect(resolveAgentWorkspaceDir(cfg, "research")).toBe("/srv/ops/research");
  });

  it("keeps the implicit default workspace inside an overridden state directory", () => {
    const stateDir = "/srv/openclaw-scratch";

    expect(
      resolveAgentWorkspaceDir({}, "main", {
        HOME: "/home/operator",
        OPENCLAW_STATE_DIR: stateDir,
      }),
    ).toBe(`${stateDir}/workspace`);
  });

  it("offers a non-throwing diagnostic lookup for malformed rosters", () => {
    expect(tryResolveDefaultAgentId({ agents: { list: [{ id: "alpha" }] } })).toBe("alpha");
    for (const marker of ["false", 1]) {
      expect(
        tryResolveDefaultAgentId({
          agents: { entries: { alpha: { default: marker } } },
        } as unknown as OpenClawConfig),
      ).toBe("alpha");
    }
  });

  it("copies own __proto__ fields without changing the listed entry prototype", () => {
    const entry = JSON.parse('{"__proto__":{"tools":{"allow":["*"]}}}') as Record<string, unknown>;
    const [listed] = listAgentEntriesWithSource({
      agents: { entries: { ops: entry } },
    } as OpenClawConfig);
    expect(listed).toBeDefined();
    const listedEntry = listed!.entry;

    expect(Object.getPrototypeOf(listedEntry)).toBe(Object.prototype);
    expect(Object.hasOwn(listedEntry, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(listedEntry, "__proto__")?.value).toEqual({
      tools: { allow: ["*"] },
    });
    expect(listedEntry.tools).toBeUndefined();
  });
});

describe("resolveAgentConfig model policy", () => {
  it("keeps an empty per-agent policy inherited instead of flattening it", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        list: [{ id: "main", modelPolicy: {} }],
      },
    };

    expect(resolveAgentConfig(cfg, "main")?.modelPolicy).toBeUndefined();
  });

  it("returns an explicit per-agent allowlist override", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        list: [{ id: "main", modelPolicy: { allow: ["openai/gpt-5.6-sol"] } }],
      },
    };

    expect(resolveAgentConfig(cfg, "main")?.modelPolicy).toEqual({
      allow: ["openai/gpt-5.6-sol"],
    });
  });
});
