/** Tests agent scope config, model selection, fallbacks, and workspace resolution. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import { withEnv } from "../test-utils/env.js";
import { findOverlappingWorkspaceAgentIds } from "./agent-delete-safety.js";
import {
  clearAutoFallbackPrimaryProbeSelection,
  hasLegacyAutoFallbackWithoutOrigin,
  markAutoFallbackPrimaryProbe,
  resolveAgentConfig,
  resolveDefaultAgentDir,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
  resolveAgentExplicitModelPrimary,
  resolveAgentSkillsFilter,
  resolveAgentModelFallbacksOverride,
  resolveRunModelFallbacksOverride,
  resolveSubagentModelFallbacksOverride,
  resolveAgentWorkspaceDir,
  resolveAgentRunCwd,
  resolveAgentWorkspaceProvisioning,
  resolveAutoFallbackPrimaryProbe,
  resolveAgentIdByWorkspacePath,
  setAgentEffectiveModelPrimary,
} from "./agent-scope.js";
import type { ModelFallbackAvailability } from "./model-fallback.types.js";
import {
  modelFallbackOverrideFromAvailability,
  resolveEffectiveModelFallbacks,
  resolveModelFallbackAvailability,
} from "./model-selection-config.js";

function agentConfig(agents: NonNullable<OpenClawConfig["agents"]>): OpenClawConfig {
  return { agents };
}
function modelConfig(primary: string, fallbacks: string[]): AgentModelConfig {
  return { primary, fallbacks };
}
function workspaceConfig(entries: NonNullable<NonNullable<OpenClawConfig["agents"]>["entries"]>) {
  return agentConfig({ defaults: { workspace: "/shared-ws" }, entries });
}

function fallbackEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session",
    updatedAt: 1,
    providerOverride: "google",
    modelOverride: "gemini-3-pro",
    modelOverrideSource: "auto",
    modelOverrideFallbackOriginProvider: "anthropic",
    modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
    ...overrides,
  };
}
type ProbeParams = Parameters<typeof resolveAutoFallbackPrimaryProbe>[0];
function probeEntry(entry: ProbeParams["entry"], overrides: Partial<ProbeParams> = {}) {
  return resolveAutoFallbackPrimaryProbe({
    entry,
    primaryProvider: "anthropic",
    primaryModel: "claude-sonnet-4-6",
    ...overrides,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("resolveAgentConfig", () => {
  it("prefers per-agent verbose defaults over global defaults", () => {
    const cfg = agentConfig({
      defaults: { verboseDefault: "full" },
      entries: { main: { verboseDefault: "on" } },
    });
    expect(resolveAgentConfig(cfg, "main")?.verboseDefault).toBe("on");
  });

  it("merges contextLimits from defaults with per-agent overrides", () => {
    const cfg = agentConfig({
      defaults: { contextLimits: { memoryGetMaxChars: 20_000 } },
      entries: {
        main: {
          skillsLimits: { maxSkillsPromptChars: 30_000 },
          contextLimits: { memoryGetMaxChars: 24_000 },
        },
      },
    });

    expect(resolveAgentConfig(cfg, "main")?.contextLimits).toEqual({
      memoryGetMaxChars: 24_000,
    });
  });

  it("merges experimental flags from defaults with per-agent overrides", () => {
    const cfg = agentConfig({
      defaults: { experimental: { localModelLean: true } },
      entries: { main: { experimental: { localModelLean: false } } },
    });

    expect(resolveAgentConfig(cfg, "main")?.experimental).toEqual({
      localModelLean: false,
    });
  });

  it.each([
    ["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"],
    [modelConfig("openai/gpt-5.4", ["anthropic/claude-sonnet-4-6"]), "openai/gpt-5.4"],
    [undefined, undefined],
  ] as const)("resolves explicit and inherited primary separately for %j", (model, expected) => {
    const cfg = agentConfig({ ...(model ? { defaults: { model } } : {}), entries: { main: {} } });
    expect(resolveAgentExplicitModelPrimary(cfg, "main")).toBeUndefined();
    expect(resolveAgentEffectiveModelPrimary(cfg, "main")).toBe(expected);
  });

  it("reports no configured fallbacks", () => {
    expect(
      resolveModelFallbackAvailability({
        cfg: { agents: { entries: { main: {} } } },
        agentId: "main",
        hasSessionModelOverride: false,
      }),
    ).toEqual({ kind: "none_configured", source: "inherited" });
  });

  it("keeps configured fallbacks for saved user selections matching the effective primary", () => {
    const cfg = agentConfig({
      defaults: {
        model: modelConfig("openai/gpt-5.4", ["anthropic/claude-sonnet-4-6"]),
      },
      entries: {
        main: {},
        worker: { model: modelConfig("anthropic/claude-sonnet-4-6", ["openai/gpt-5.4"]) },
      },
    });
    const selection = {
      cfg,
      agentId: "main",
      hasSessionModelOverride: true,
      modelOverrideSource: "user" as const,
      selectedModel: { provider: "openai", model: "gpt-5.4" },
    };
    expect(resolveModelFallbackAvailability(selection)).toEqual({
      kind: "active",
      models: ["anthropic/claude-sonnet-4-6"],
      source: "inherited",
    });
    expect(resolveEffectiveModelFallbacks(selection)).toBeUndefined();
    expect(
      resolveEffectiveModelFallbacks({
        ...selection,
        agentId: "worker",
        selectedModel: { provider: "anthropic", model: "claude-sonnet-4-6" },
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(resolveEffectiveModelFallbacks({ ...selection, agentId: "worker" })).toEqual([]);
    expect(resolveModelFallbackAvailability({ ...selection, modelSelectionLocked: true })).toEqual({
      kind: "disabled_by_model_selection_lock",
    });
    expect(resolveModelFallbackAvailability({ ...selection, modelFallbacksOverride: [] })).toEqual({
      kind: "none_configured",
      source: "explicit",
    });
  });

  it("keeps a request-supplied ladder when the run pins a model", () => {
    const cfg = agentConfig({
      defaults: {
        model: modelConfig("openai/gpt-5.4", ["anthropic/claude-sonnet-4-6"]),
      },
      entries: { main: {} },
    });
    const selection = {
      cfg,
      agentId: "main",
      hasSessionModelOverride: true,
      modelOverrideSource: "user" as const,
      selectedModel: { provider: "minimax-portal", model: "MiniMax-M3" },
      modelFallbacksOverride: ["anthropic/claude-sonnet-4-6"],
    };
    expect(resolveModelFallbackAvailability(selection)).toEqual({
      kind: "active",
      models: ["anthropic/claude-sonnet-4-6"],
      source: "explicit",
    });
    expect(resolveEffectiveModelFallbacks(selection)).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  describe("modelFallbackOverrideFromAvailability", () => {
    const projectionRows: Array<[string, ModelFallbackAvailability]> = [
      [
        "leaves inherited fallbacks to the candidate resolver",
        { kind: "active", models: ["openai/gpt-5.4"], source: "inherited" },
      ],
      [
        "leaves inherited empty fallbacks to the candidate resolver",
        { kind: "none_configured", source: "inherited" },
      ],
    ];
    it.each(projectionRows)("%s", (_name, availability) => {
      expect(modelFallbackOverrideFromAvailability(availability)).toBeUndefined();
    });
  });

  it("supports per-agent model primary+fallbacks", () => {
    const withModel = (
      model: AgentModelConfig,
      defaultModel?: AgentModelConfig,
    ): OpenClawConfig => ({
      agents: {
        ...(defaultModel ? { defaults: { model: defaultModel } } : {}),
        entries: { linus: { model } },
      },
    });
    const cfg = withModel(
      { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["openai/gpt-5.4"] },
      { primary: "openai/gpt-5.4", fallbacks: ["anthropic/claude-sonnet-4-6"] },
    );
    const fallbacks = (
      config: OpenClawConfig,
      options: Partial<Parameters<typeof resolveEffectiveModelFallbacks>[0]> = {},
    ) =>
      resolveEffectiveModelFallbacks({
        cfg: config,
        agentId: "linus",
        hasSessionModelOverride: false,
        ...options,
      });

    expect(resolveAgentExplicitModelPrimary(cfg, "linus")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveAgentEffectiveModelPrimary(cfg, "linus")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveAgentModelFallbacksOverride(cfg, "linus")).toEqual(["openai/gpt-5.4"]);

    // If an agent owns a primary, missing fallbacks means no model fallback.
    const cfgNoOverride = withModel({ primary: "anthropic/claude-sonnet-4-6" });
    expect(resolveAgentModelFallbacksOverride(cfgNoOverride, "linus")).toStrictEqual([]);
    expect(fallbacks(cfgNoOverride)).toStrictEqual([]);

    const cfgStringModel = withModel("anthropic/claude-sonnet-4-6");
    expect(resolveAgentModelFallbacksOverride(cfgStringModel, "linus")).toStrictEqual([]);

    const cfgStrictAgentWithDefaultFallbacks = withModel(
      { primary: "opencode-go/minimax-m2.7" },
      { fallbacks: ["custom-opencode-go-extras/deepseek-v4-flash"] },
    );
    expect(resolveAgentModelFallbacksOverride(cfgStrictAgentWithDefaultFallbacks, "linus")).toEqual(
      [],
    );
    expect(
      fallbacks(cfgStrictAgentWithDefaultFallbacks, {
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
      }),
    ).toStrictEqual([]);

    // Explicit empty list disables global fallbacks for that agent.
    const cfgDisable = withModel({
      primary: "anthropic/claude-sonnet-4-6",
      fallbacks: [],
    });
    expect(resolveAgentModelFallbacksOverride(cfgDisable, "linus")).toStrictEqual([]);

    expect(fallbacks(cfg)).toEqual(["openai/gpt-5.4"]);
    const overridden = (options: Partial<Parameters<typeof fallbacks>[1]> = {}) =>
      fallbacks(cfg, { hasSessionModelOverride: true, ...options });
    expect(overridden({ modelOverrideSource: "auto" })).toEqual(["openai/gpt-5.4"]);
    expect(overridden({ modelOverrideSource: "user" })).toStrictEqual([]);
    expect(overridden()).toStrictEqual([]);
    expect(overridden({ hasAutoFallbackProvenance: true })).toEqual(["openai/gpt-5.4"]);
    expect(
      overridden({ modelOverrideSource: "user", hasAutoFallbackProvenance: true }),
    ).toStrictEqual([]);
    expect(fallbacks(cfgNoOverride, { hasSessionModelOverride: true })).toStrictEqual([]);

    const cfgInheritDefaultsWithoutAgentModel = agentConfig({
      defaults: { model: { fallbacks: ["openai/gpt-5.4"] } },
      entries: { linus: {} },
    });
    expect(
      fallbacks(cfgInheritDefaultsWithoutAgentModel, {
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      fallbacks(cfgDisable, { hasSessionModelOverride: true, modelOverrideSource: "auto" }),
    ).toStrictEqual([]);
  });

  it("updates the effective model primary at the winning config layer", () => {
    const cfg = agentConfig({
      defaults: { model: modelConfig("openai/gpt-5.4", ["anthropic/claude-sonnet-4-6"]) },
      entries: {
        linus: {
          model: modelConfig("anthropic/claude-sonnet-4-6", [
            "openrouter/anthropic/claude-opus-4.6",
          ]),
        },
      },
    });

    expect(setAgentEffectiveModelPrimary(cfg, "linus", "google/gemini-3-pro")).toBe("agent");
    expect(cfg.agents?.entries?.linus?.model).toEqual({
      primary: "google/gemini-3-pro",
      fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
    });
    expect(cfg.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });

    const inheritedCfg: OpenClawConfig = {
      agents: {
        defaults: structuredClone(cfg.agents?.defaults),
        entries: { main: {} },
      },
    };

    expect(setAgentEffectiveModelPrimary(inheritedCfg, "main", "google/gemini-3-pro")).toBe(
      "defaults",
    );
    expect(inheritedCfg.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3-pro",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
  });

  it.each([
    ["main", "agent", "openai/gpt-5.4", "test/next"],
    ["work", "defaults", "test/next", undefined],
  ] as const)(
    "writes the explicit model target for %s at %s",
    (agentId, target, defaultsModel, mainModel) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: "openai/gpt-5.4" },
          entries: { main: {}, work: { model: "anthropic/claude-sonnet-4-6" } },
        },
      };
      expect(setAgentEffectiveModelPrimary(cfg, agentId, "test/next", { target })).toBe(target);
      expect(cfg.agents).toEqual({
        defaults: { model: defaultsModel },
        entries: {
          main: mainModel ? { model: mainModel } : {},
          work: { model: "anthropic/claude-sonnet-4-6" },
        },
      });
    },
  );

  it("resolves run fallback overrides via shared helper", () => {
    const cfg = agentConfig({
      defaults: { model: { fallbacks: ["anthropic/claude-sonnet-4-6"] } },
      entries: { support: { model: { fallbacks: ["openai/gpt-5.4"] } } },
    });

    expect(
      resolveRunModelFallbacksOverride({
        cfg,
        agentId: "support",
        sessionKey: "agent:main:session",
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveRunModelFallbacksOverride({
        cfg,
        agentId: undefined,
        sessionKey: "agent:support:session",
      }),
    ).toEqual(["openai/gpt-5.4"]);
  });

  it("resolves throttled primary probes for auto fallback selections", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const entry = fallbackEntry({
      authProfileOverride: "google:fallback",
      authProfileOverrideSource: "auto",
    });
    const probe = (now: number, currentEntry = entry) => {
      clock.mockReturnValue(now);
      return probeEntry(currentEntry, {
        sessionKey: "agent:main:throttled-probe",
      });
    };

    expect(probe(1_000)).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackAuthProfileId: "google:fallback",
      fallbackAuthProfileIdSource: "auto",
    });
    markAutoFallbackPrimaryProbe({
      probe: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        fallbackProvider: "google",
        fallbackModel: "gemini-3-pro",
      },
      sessionKey: "agent:main:throttled-probe",
    });
    expect(probe(30_000)).toBeUndefined();
    expect(
      probe(30_000, { ...entry, providerOverride: "openai", modelOverride: "gpt-5.4" }),
    ).toBeUndefined();
    expect(probe(300_999)).toBeUndefined();
    expect(probe(301_000)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  it("skips primary probes for strict or stale fallback selections", () => {
    const baseEntry = fallbackEntry();

    expect(probeEntry({ ...baseEntry, modelOverrideSource: "user" })).toBeUndefined();
    expect(
      probeEntry(baseEntry, {
        primaryProvider: "openai",
        primaryModel: "gpt-5.4",
      }),
    ).toBeUndefined();
    expect(
      probeEntry({
        ...baseEntry,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
      }),
    ).toBeUndefined();
  });

  it.each([
    ["anthropic", "claude-sonnet-4-6", false],
    [" ", "claude-sonnet-4-6", true],
    ["anthropic", undefined, true],
  ] as const)("identifies legacy auto fallback origin %j/%j", (provider, model, expected) => {
    expect(
      hasLegacyAutoFallbackWithoutOrigin({
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: provider,
        modelOverrideFallbackOriginModel: model,
      }),
    ).toBe(expected);
  });

  it.each([{ modelOverrideSource: "user" }, {}, undefined] as const)(
    "does not classify %j as a legacy auto fallback",
    (entry) => expect(hasLegacyAutoFallbackWithoutOrigin(entry)).toBe(false),
  );

  it("recognizes recovered auto fallback provenance without a source marker", () => {
    expect(
      probeEntry({
        providerOverride: "google",
        modelOverride: "gemini-3-pro",
        modelOverrideFallbackOriginProvider: "anthropic",
        modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      }),
    ).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  it.each([
    {
      name: "auto",
      overrides: {
        authProfileOverride: "fallback-key",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 1,
        fallbackNotice: {
          kind: "active",
          selectedModel: "google/gemini-3-pro",
          activeModel: "google/gemini-3-pro",
          reason: "rate_limit",
        },
      },
      expected: {},
    },
    {
      name: "legacy",
      overrides: { authProfileOverride: "fallback-key", authProfileOverrideCompactionCount: 1 },
      expected: {},
    },
    {
      name: "user",
      overrides: { authProfileOverride: "selected-key", authProfileOverrideSource: "user" },
      expected: { authProfileOverride: "selected-key", authProfileOverrideSource: "user" },
    },
  ] as const)(
    "clears fallback state while respecting $name auth ownership",
    ({ overrides, expected }) => {
      vi.spyOn(Date, "now").mockReturnValue(2);
      const entry = fallbackEntry(overrides);
      clearAutoFallbackPrimaryProbeSelection(entry);
      expect(entry).toEqual({ sessionId: "session", updatedAt: 2, ...expected });
    },
  );

  it("resolves subagent model fallbacks from the selected subagent model source", () => {
    const cfg = agentConfig({
      defaults: {
        model: modelConfig("anthropic/claude-opus-4-6", ["openai/gpt-5.4"]),
        subagents: { model: modelConfig("kimi/kimi-code", ["openai/gpt-5.4", "zai/glm-5"]) },
      },
      entries: {
        research: {
          subagents: { model: modelConfig("kimi/kimi-code", ["openai/gpt-5.4", "zai/glm-5"]) },
        },
        "agent-model": {
          model: modelConfig("anthropic/claude-sonnet-4-6", ["google/gemini-3-pro"]),
        },
        "fallback-only-agent-model": { model: { fallbacks: ["google/gemini-3-pro"] } },
        "fallback-only-subagent-model": { subagents: { model: { fallbacks: [] } } },
        "default-subagent": {},
        strict: { subagents: { model: "kimi/kimi-code" } },
      },
    });

    for (const id of ["research", "agent-model", "fallback-only-agent-model", "default-subagent"]) {
      expect(resolveSubagentModelFallbacksOverride(cfg, id)).toEqual([
        "openai/gpt-5.4",
        "zai/glm-5",
      ]);
    }
    for (const id of ["fallback-only-subagent-model", "strict"]) {
      expect(resolveSubagentModelFallbacksOverride(cfg, id)).toStrictEqual([]);
    }
  });

  it("uses subagent model fallbacks for auto-selected spawned subagent models", () => {
    const cfg = agentConfig({
      defaults: {
        model: { fallbacks: ["openai/gpt-5.4"] },
        subagents: { model: modelConfig("kimi/kimi-code", ["openai/gpt-5.4", "zai/glm-5"]) },
      },
      entries: {
        research: { model: modelConfig("anthropic/claude-sonnet-4-6", ["google/gemini-3-pro"]) },
        "fallback-only-subagent": {
          model: modelConfig("anthropic/claude-sonnet-4-6", ["google/gemini-3-pro"]),
          subagents: { model: { fallbacks: ["zai/glm-5"] } },
        },
      },
    });

    const fallbacks = (agentId: string, modelOverrideSource: "auto" | "user") =>
      resolveEffectiveModelFallbacks({
        cfg,
        agentId,
        sessionKey: `agent:${agentId}:subagent:child`,
        hasSessionModelOverride: true,
        modelOverrideSource,
      });
    expect(fallbacks("research", "auto")).toEqual(["openai/gpt-5.4", "zai/glm-5"]);
    expect(fallbacks("research", "user")).toStrictEqual([]);
    expect(fallbacks("fallback-only-subagent", "auto")).toEqual(["zai/glm-5"]);
  });

  it("uses OPENCLAW_WORKSPACE_DIR for default agent workspace", () => {
    const workspaceDir = path.join(path.sep, "srv", "openclaw-workspace");
    withEnv(
      {
        OPENCLAW_WORKSPACE_DIR: workspaceDir,
        OPENCLAW_HOME: path.join(path.sep, "srv", "openclaw-home"),
      },
      () => {
        const workspace = resolveAgentWorkspaceDir({ agents: { entries: { main: {} } } }, "main");
        expect(workspace).toBe(path.resolve(workspaceDir));
      },
    );
  });

  it("uses OPENCLAW_HOME for default agentDir", () => {
    const home = path.join(path.sep, "srv", "openclaw-home");
    withEnv({ OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: "" }, () => {
      const agentDir = resolveAgentDir({} as OpenClawConfig, "main");
      expect(agentDir).toBe(path.join(path.resolve(home), ".openclaw", "agents", "main", "agent"));
    });
  });

  it("resolves default agentDir from the configured default agent", () => {
    const stateDir = path.join(path.sep, "tmp", "test-state");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { main: {}, ops: {} },
      },
    };

    const agentDir = withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => resolveDefaultAgentDir(cfg));

    expect(agentDir).toBe(path.resolve(stateDir, "agents", "ops", "agent"));
  });

  it("non-default agent uses agents.defaults.workspace as base (#59789)", () => {
    const cfg = workspaceConfig({ main: {}, work: { workspace: "/work-ws" } });
    const workspace = resolveAgentWorkspaceDir(cfg, "main");
    expect(workspace).toBe(path.resolve("/shared-ws/main"));
  });

  it("non-default agent without defaults.workspace falls back to stateDir", () => {
    const stateDir = path.join(path.sep, "tmp", "test-state");
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {}, work: { workspace: "/work-ws" } },
      },
    };
    const workspace = withEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
      resolveAgentWorkspaceDir(cfg, "main"),
    );
    expect(workspace).toBe(path.resolve(stateDir, "workspace-main"));
  });
});

describe("resolveAgentRunCwd", () => {
  it("ignores blank cwd without relocating workspace", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { cwd: "/default-repo" },
        entries: { work: { cwd: " ", workspace: "/agent-workspace" } },
      },
    };
    withEnv({ OPENCLAW_HOME: "/srv/openclaw-home" }, () => {
      expect(resolveAgentRunCwd(cfg, "WORK")).toBe(path.resolve("/default-repo"));
      expect(resolveAgentWorkspaceDir(cfg, "work")).toBe(path.resolve("/agent-workspace"));
    });
  });
});

describe("resolveAgentWorkspaceProvisioning", () => {
  it("keeps standard provisioning when the ACP agent declares an explicit workspace (#92015)", () => {
    const cfg = workspaceConfig({
      codex: {
        workspace: "/explicit-ws",
        runtime: { type: "acp", acp: { cwd: "/projects/app" } },
      },
    });
    expect(resolveAgentWorkspaceProvisioning(cfg, "codex")).toBe("standard");
    expect(resolveAgentWorkspaceProvisioning(cfg, "codex", { cwd: "/projects/app" })).toBe(
      "standard",
    );
  });

  it("lets the invocation cwd win over the runtime default when it equals the workspace", () => {
    const cfg = workspaceConfig({
      main: {},
      codex: { runtime: { type: "acp", acp: { cwd: "/projects/app" } } },
    });
    expect(resolveAgentWorkspaceProvisioning(cfg, "codex", { cwd: "/shared-ws/codex" })).toBe(
      "standard",
    );
  });

  it("keeps standard provisioning for a provisioned dir that is not the implicit workspace", () => {
    const cfg = workspaceConfig({
      codex: { runtime: { type: "acp", acp: { cwd: "/projects/app" } } },
    });
    expect(
      resolveAgentWorkspaceProvisioning(cfg, "codex", {
        cwd: "/projects/app",
        workspaceDir: "/spawned-override-ws",
      }),
    ).toBe("standard");
  });

  it("keeps standard provisioning for embedded agents without an explicit workspace", () => {
    const cfg = workspaceConfig({ main: {}, work: { runtime: { type: "embedded" } } });
    expect(resolveAgentWorkspaceProvisioning(cfg, "work")).toBe("standard");
    expect(resolveAgentWorkspaceProvisioning(cfg, "main")).toBe("standard");
  });
});

describe("resolveAgentIdByWorkspacePath", () => {
  it.runIf(process.platform === "linux")(
    "keeps distinct Unicode workspace directories under their own agents",
    () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workspace-unicode-")));
      const composed = path.join(root, "caf\u00e9");
      const decomposed = path.join(root, "cafe\u0301");
      try {
        fs.mkdirSync(composed);
        fs.mkdirSync(decomposed);
        const cfg: OpenClawConfig = {
          agents: {
            entries: {
              composed: { workspace: composed },
              decomposed: { workspace: decomposed },
            },
          },
        };

        expect(fs.statSync(composed).ino).not.toBe(fs.statSync(decomposed).ino);
        expect(resolveAgentIdByWorkspacePath(cfg, composed)).toBe("composed");
        expect(resolveAgentIdByWorkspacePath(cfg, decomposed)).toBe("decomposed");
        expect(findOverlappingWorkspaceAgentIds(cfg, "composed", composed)).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("matches a dangling workspace symlink to its vanished target", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-scope-dangling-"));
    const workspaceDir = path.join(tempRoot, "vanished-workspace");
    const workspaceAliasDir = path.join(tempRoot, "workspace-alias");
    try {
      fs.symlinkSync(
        workspaceDir,
        workspaceAliasDir,
        process.platform === "win32" ? "junction" : "dir",
      );
      const cfg: OpenClawConfig = {
        agents: { entries: { ops: { workspace: workspaceAliasDir } } },
      };

      expect(resolveAgentIdByWorkspacePath(cfg, workspaceDir)).toBe("ops");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps a cyclic workspace alias bounded and separate from unrelated paths", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "workspace-cycle-")));
    const alias = path.join(root, "alias");
    try {
      fs.symlinkSync(alias, alias, process.platform === "win32" ? "junction" : "dir");
      const cfg: OpenClawConfig = { agents: { entries: { ops: { workspace: alias } } } };

      expect(resolveAgentIdByWorkspacePath(cfg, alias)).toBe("ops");
      expect(resolveAgentIdByWorkspacePath(cfg, path.join(root, "other"))).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveAgentSkillsFilter", () => {
  it("uses agents.entries skills as a full replacement", () => {
    const cfg = agentConfig({
      defaults: { skills: ["github", "weather"] },
      entries: { writer: { skills: ["docs-search"] } },
    });

    expect(resolveAgentSkillsFilter(cfg, "writer")).toEqual(["docs-search"]);
  });
});
