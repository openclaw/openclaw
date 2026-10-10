/** Tests agent scope config, model selection, fallbacks, and workspace resolution. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import { withEnv } from "../test-utils/env.js";
import { findOverlappingWorkspaceAgentIds } from "./agent-delete-safety.js";
import type { ModelFallbackAvailability } from "./agent-scope.js";
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
  modelFallbackOverrideFromAvailability,
  resolveEffectiveModelFallbacks,
  resolveModelFallbackAvailability,
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

describe("resolveAgentConfig", () => {
  it("prefers per-agent verbose defaults over global defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          verboseDefault: "full",
        },
        entries: { main: { verboseDefault: "on" } },
      },
    };
    expect(resolveAgentConfig(cfg, "main")?.verboseDefault).toBe("on");
  });

  it("merges contextLimits from defaults with per-agent overrides", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          contextLimits: {
            memoryGetMaxChars: 20_000,
          },
        },
        entries: {
          main: {
            skillsLimits: {
              maxSkillsPromptChars: 30_000,
            },
            contextLimits: {
              memoryGetMaxChars: 24_000,
            },
          },
        },
      },
    };

    expect(resolveAgentConfig(cfg, "main")?.contextLimits).toEqual({
      memoryGetMaxChars: 24_000,
    });
  });

  it("merges experimental flags from defaults with per-agent overrides", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
        entries: {
          main: {
            experimental: {
              localModelLean: false,
            },
          },
        },
      },
    };

    expect(resolveAgentConfig(cfg, "main")?.experimental).toEqual({
      localModelLean: false,
    });
  });

  it("resolves explicit and effective model primary separately", () => {
    const cfgWithStringDefault = {
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
        },
        entries: { main: {} },
      },
    } as unknown as OpenClawConfig;
    expect(resolveAgentExplicitModelPrimary(cfgWithStringDefault, "main")).toBeUndefined();
    expect(resolveAgentEffectiveModelPrimary(cfgWithStringDefault, "main")).toBe(
      "anthropic/claude-sonnet-4-6",
    );

    const cfgWithObjectDefault: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        entries: { main: {} },
      },
    };
    expect(resolveAgentExplicitModelPrimary(cfgWithObjectDefault, "main")).toBeUndefined();
    expect(resolveAgentEffectiveModelPrimary(cfgWithObjectDefault, "main")).toBe("openai/gpt-5.4");

    const cfgNoDefaults: OpenClawConfig = {
      agents: {
        entries: { main: {} },
      },
    };
    expect(resolveAgentExplicitModelPrimary(cfgNoDefaults, "main")).toBeUndefined();
    expect(resolveAgentEffectiveModelPrimary(cfgNoDefaults, "main")).toBeUndefined();
  });

  describe("resolveModelFallbackAvailability", () => {
    it("reports no configured fallbacks", () => {
      expect(
        resolveModelFallbackAvailability({
          cfg: { agents: { entries: { main: {} } } },
          agentId: "main",
          hasSessionModelOverride: false,
        }),
      ).toEqual({ kind: "none_configured", source: "inherited" });
    });
  });

  describe("modelFallbackOverrideFromAvailability", () => {
    const projectionRows: Array<{
      name: string;
      availability: ModelFallbackAvailability;
      expected: string[] | undefined;
    }> = [
      {
        name: "leaves inherited fallbacks to the candidate resolver",
        availability: { kind: "active", models: ["openai/gpt-5.4"], source: "inherited" },
        expected: undefined,
      },
      {
        name: "leaves inherited empty fallbacks to the candidate resolver",
        availability: { kind: "none_configured", source: "inherited" },
        expected: undefined,
      },
    ];
    it.each(projectionRows)("$name", ({ availability, expected }) => {
      expect(modelFallbackOverrideFromAvailability(availability)).toEqual(expected);
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

    expect(resolveAgentExplicitModelPrimary(cfg, "linus")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveAgentEffectiveModelPrimary(cfg, "linus")).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveAgentModelFallbacksOverride(cfg, "linus")).toEqual(["openai/gpt-5.4"]);

    // If an agent owns a primary, missing fallbacks means no model fallback.
    const cfgNoOverride = withModel({ primary: "anthropic/claude-sonnet-4-6" });
    expect(resolveAgentModelFallbacksOverride(cfgNoOverride, "linus")).toStrictEqual([]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg: cfgNoOverride,
        agentId: "linus",
        hasSessionModelOverride: false,
      }),
    ).toStrictEqual([]);

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
      resolveEffectiveModelFallbacks({
        cfg: cfgStrictAgentWithDefaultFallbacks,
        agentId: "linus",
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

    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: false,
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: true,
        modelOverrideSource: "user",
      }),
    ).toStrictEqual([]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: true,
      }),
    ).toStrictEqual([]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: true,
        hasAutoFallbackProvenance: true,
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "linus",
        hasSessionModelOverride: true,
        modelOverrideSource: "user",
        hasAutoFallbackProvenance: true,
      }),
    ).toStrictEqual([]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg: cfgNoOverride,
        agentId: "linus",
        hasSessionModelOverride: true,
      }),
    ).toStrictEqual([]);

    const cfgInheritDefaultsWithoutAgentModel: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.4"],
          },
        },
        entries: { linus: {} },
      },
    };
    expect(
      resolveEffectiveModelFallbacks({
        cfg: cfgInheritDefaultsWithoutAgentModel,
        agentId: "linus",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
      }),
    ).toEqual(["openai/gpt-5.4"]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg: cfgDisable,
        agentId: "linus",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
      }),
    ).toStrictEqual([]);
  });

  it("updates the effective model primary at the winning config layer", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        entries: {
          linus: {
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
            },
          },
        },
      },
    };

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
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        entries: {
          support: {
            model: {
              fallbacks: ["openai/gpt-5.4"],
            },
          },
        },
      },
    };

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
    const probeState = new Map<string, number>();
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      authProfileOverride: "google:fallback",
      authProfileOverrideSource: "auto",
    };

    expect(
      resolveAutoFallbackPrimaryProbe({
        entry,
        sessionKey: "agent:main:session",
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        now: 1_000,
        minIntervalMs: 60_000,
        probeState,
      }),
    ).toMatchObject({
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
      sessionKey: "agent:main:session",
      now: 1_000,
      probeState,
    });
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry,
        sessionKey: "agent:main:session",
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        now: 30_000,
        minIntervalMs: 60_000,
        probeState,
      }),
    ).toBeUndefined();
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry: {
          ...entry,
          providerOverride: "openai",
          modelOverride: "gpt-5.4",
        },
        sessionKey: "agent:main:session",
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        now: 30_000,
        minIntervalMs: 60_000,
        probeState,
      }),
    ).toBeUndefined();
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry,
        sessionKey: "agent:main:session",
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        now: 70_000,
        minIntervalMs: 60_000,
        probeState,
      }),
    ).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  it("skips primary probes for strict or stale fallback selections", () => {
    const baseEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
    };

    expect(
      resolveAutoFallbackPrimaryProbe({
        entry: { ...baseEntry, modelOverrideSource: "user" },
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        probeState: new Map(),
      }),
    ).toBeUndefined();
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry: baseEntry,
        primaryProvider: "openai",
        primaryModel: "gpt-5.4",
        probeState: new Map(),
      }),
    ).toBeUndefined();
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry: {
          ...baseEntry,
          providerOverride: "anthropic",
          modelOverride: "claude-sonnet-4-6",
        },
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        probeState: new Map(),
      }),
    ).toBeUndefined();
  });

  it("identifies legacy auto fallback overrides without origin metadata", () => {
    expect(
      hasLegacyAutoFallbackWithoutOrigin({
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "anthropic",
        modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      }),
    ).toBe(false);
    expect(
      hasLegacyAutoFallbackWithoutOrigin({
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: " ",
        modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      }),
    ).toBe(true);
    expect(
      hasLegacyAutoFallbackWithoutOrigin({
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "anthropic",
      }),
    ).toBe(true);
    expect(
      hasLegacyAutoFallbackWithoutOrigin({
        modelOverrideSource: "user",
      }),
    ).toBe(false);
    expect(hasLegacyAutoFallbackWithoutOrigin({})).toBe(false);
    expect(hasLegacyAutoFallbackWithoutOrigin(undefined)).toBe(false);
  });

  it("recognizes recovered auto fallback provenance without a source marker", () => {
    expect(
      resolveAutoFallbackPrimaryProbe({
        entry: {
          providerOverride: "google",
          modelOverride: "gemini-3-pro",
          modelOverrideFallbackOriginProvider: "anthropic",
          modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
        },
        primaryProvider: "anthropic",
        primaryModel: "claude-sonnet-4-6",
        probeState: new Map(),
      }),
    ).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  it("clears only auto-owned fallback selection state for a primary probe", () => {
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      authProfileOverride: "fallback-key",
      authProfileOverrideSource: "auto",
      authProfileOverrideCompactionCount: 1,
      fallbackNotice: {
        kind: "active",
        selectedModel: "google/gemini-3-pro",
        activeModel: "google/gemini-3-pro",
        reason: "rate_limit",
      },
    };

    clearAutoFallbackPrimaryProbeSelection(entry, 2);

    expect(entry).toEqual({ sessionId: "session", updatedAt: 2 });
  });

  it("clears legacy auto auth selection when clearing primary probe state", () => {
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      authProfileOverride: "fallback-key",
      authProfileOverrideCompactionCount: 1,
    };

    clearAutoFallbackPrimaryProbeSelection(entry, 2);

    expect(entry).toEqual({ sessionId: "session", updatedAt: 2 });
  });

  it("preserves user-owned auth selection when clearing primary probe state", () => {
    const entry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: "google",
      modelOverride: "gemini-3-pro",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-sonnet-4-6",
      authProfileOverride: "selected-key",
      authProfileOverrideSource: "user",
    };

    clearAutoFallbackPrimaryProbeSelection(entry, 2);

    expect(entry).toEqual({
      sessionId: "session",
      updatedAt: 2,
      authProfileOverride: "selected-key",
      authProfileOverrideSource: "user",
    });
  });

  it("resolves subagent model fallbacks from the selected subagent model source", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.4"],
          },
          subagents: {
            model: {
              primary: "kimi/kimi-code",
              fallbacks: ["openai/gpt-5.4", "zai/glm-5"],
            },
          },
        },
        entries: {
          research: {
            subagents: {
              model: {
                primary: "kimi/kimi-code",
                fallbacks: ["openai/gpt-5.4", "zai/glm-5"],
              },
            },
          },
          "agent-model": {
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["google/gemini-3-pro"],
            },
          },
          "fallback-only-agent-model": {
            model: {
              fallbacks: ["google/gemini-3-pro"],
            },
          },
          "fallback-only-subagent-model": {
            subagents: {
              model: {
                fallbacks: [],
              },
            },
          },
          "default-subagent": {},
          strict: {
            subagents: {
              model: "kimi/kimi-code",
            },
          },
        },
      },
    };

    expect(resolveSubagentModelFallbacksOverride(cfg, "research")).toEqual([
      "openai/gpt-5.4",
      "zai/glm-5",
    ]);
    expect(resolveSubagentModelFallbacksOverride(cfg, "agent-model")).toEqual([
      "openai/gpt-5.4",
      "zai/glm-5",
    ]);
    expect(resolveSubagentModelFallbacksOverride(cfg, "fallback-only-agent-model")).toEqual([
      "openai/gpt-5.4",
      "zai/glm-5",
    ]);
    expect(
      resolveSubagentModelFallbacksOverride(cfg, "fallback-only-subagent-model"),
    ).toStrictEqual([]);
    expect(resolveSubagentModelFallbacksOverride(cfg, "default-subagent")).toEqual([
      "openai/gpt-5.4",
      "zai/glm-5",
    ]);
    expect(resolveSubagentModelFallbacksOverride(cfg, "strict")).toStrictEqual([]);
  });

  it("uses subagent model fallbacks for auto-selected spawned subagent models", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            fallbacks: ["openai/gpt-5.4"],
          },
          subagents: {
            model: {
              primary: "kimi/kimi-code",
              fallbacks: ["openai/gpt-5.4", "zai/glm-5"],
            },
          },
        },
        entries: {
          research: {
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["google/gemini-3-pro"],
            },
          },
          "fallback-only-subagent": {
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["google/gemini-3-pro"],
            },
            subagents: {
              model: { fallbacks: ["zai/glm-5"] },
            },
          },
        },
      },
    };

    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "research",
        sessionKey: "agent:research:subagent:child",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
      }),
    ).toEqual(["openai/gpt-5.4", "zai/glm-5"]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "research",
        sessionKey: "agent:research:subagent:child",
        hasSessionModelOverride: true,
        modelOverrideSource: "user",
      }),
    ).toStrictEqual([]);
    expect(
      resolveEffectiveModelFallbacks({
        cfg,
        agentId: "fallback-only-subagent",
        sessionKey: "agent:fallback-only-subagent:subagent:child",
        hasSessionModelOverride: true,
        modelOverrideSource: "auto",
      }),
    ).toEqual(["zai/glm-5"]);
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
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        entries: { main: {}, work: { workspace: "/work-ws" } },
      },
    };
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
  it.each([{ cwd: " ", expected: path.resolve("/default-repo") }])(
    "resolves configured path $cwd without relocating workspace",
    ({ cwd, expected }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { cwd: "/default-repo" },
          entries: { work: { cwd, workspace: "/agent-workspace" } },
        },
      };
      withEnv({ OPENCLAW_HOME: "/srv/openclaw-home" }, () => {
        expect(resolveAgentRunCwd(cfg, "WORK")).toBe(expected);
        expect(resolveAgentWorkspaceDir(cfg, "work")).toBe(path.resolve("/agent-workspace"));
      });
    },
  );
});

describe("resolveAgentWorkspaceProvisioning", () => {
  it("keeps standard provisioning when the ACP agent declares an explicit workspace (#92015)", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        entries: {
          codex: {
            workspace: "/explicit-ws",
            runtime: { type: "acp", acp: { cwd: "/projects/app" } },
          },
        },
      },
    };
    expect(resolveAgentWorkspaceProvisioning(cfg, "codex")).toBe("standard");
    expect(resolveAgentWorkspaceProvisioning(cfg, "codex", { cwd: "/projects/app" })).toBe(
      "standard",
    );
  });

  it("lets the invocation cwd win over the runtime default when it equals the workspace", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        entries: { main: {}, codex: { runtime: { type: "acp", acp: { cwd: "/projects/app" } } } },
      },
    };
    expect(resolveAgentWorkspaceProvisioning(cfg, "codex", { cwd: "/shared-ws/codex" })).toBe(
      "standard",
    );
  });

  it("keeps standard provisioning for a provisioned dir that is not the implicit workspace", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        entries: { codex: { runtime: { type: "acp", acp: { cwd: "/projects/app" } } } },
      },
    };
    expect(
      resolveAgentWorkspaceProvisioning(cfg, "codex", {
        cwd: "/projects/app",
        workspaceDir: "/spawned-override-ws",
      }),
    ).toBe("standard");
  });

  it("keeps standard provisioning for embedded agents without an explicit workspace", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        entries: { main: {}, work: { runtime: { type: "embedded" } } },
      },
    };
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
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          skills: ["github", "weather"],
        },
        entries: { writer: { skills: ["docs-search"] } },
      },
    };

    expect(resolveAgentSkillsFilter(cfg, "writer")).toEqual(["docs-search"]);
  });
});
