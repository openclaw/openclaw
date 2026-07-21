// Agent scope tests cover which per-agent fields may flatten into runtime defaults.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { resolveEffectiveToolPolicy } from "./agent-tools.policy.js";

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

describe("resolveAgentConfig tools/sandbox defaults inheritance", () => {
  it("inherits agents.defaults.tools and sandbox when the list entry omits them", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          tools: { deny: ["exec", "write", "edit"] },
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [{ id: "worker", workspace: "~/openclaw-worker" }],
      },
    };

    const resolved = resolveAgentConfig(cfg, "worker");
    expect(resolved?.tools).toEqual({ deny: ["exec", "write", "edit"] });
    expect(resolved?.sandbox).toEqual({ mode: "all", scope: "agent" });
  });

  it("prefers per-agent tools/sandbox over agents.defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          tools: { deny: ["exec"] },
          sandbox: { mode: "all" },
        },
        list: [
          {
            id: "admin",
            tools: { allow: ["read", "exec"] },
            sandbox: { mode: "off" },
          },
        ],
      },
    };

    const resolved = resolveAgentConfig(cfg, "admin");
    expect(resolved?.tools).toEqual({ allow: ["read", "exec"] });
    expect(resolved?.sandbox).toEqual({ mode: "off" });
  });

  it("surfaces defaults.tools for agent ids not yet present in agents.list", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          tools: { deny: ["exec", "process"] },
          sandbox: { mode: "non-main" },
        },
        list: [{ id: "main" }],
      },
    };

    const resolved = resolveAgentConfig(cfg, "enrolling-user");
    expect(resolved?.tools).toEqual({ deny: ["exec", "process"] });
    expect(resolved?.sandbox).toEqual({ mode: "non-main" });
  });

  it("keeps resolveAgentConfig undefined when no list entry and no containment defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "~/openclaw" },
        list: [{ id: "main" }],
      },
    };
    expect(resolveAgentConfig(cfg, "ghost")).toBeUndefined();
  });

  it("applies agents.defaults.tools via resolveEffectiveToolPolicy for list-omitted and missing agents", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          tools: {
            deny: ["exec", "write", "edit", "process"],
          },
        },
        list: [{ id: "main", workspace: "~/openclaw" }],
      },
    };

    const mainPolicy = resolveEffectiveToolPolicy({
      config: cfg,
      sessionKey: "agent:main:main",
    });
    expect(mainPolicy.agentPolicy).toEqual({
      deny: ["exec", "write", "edit", "process"],
    });

    const missingPolicy = resolveEffectiveToolPolicy({
      config: cfg,
      sessionKey: "agent:not-yet-enrolled:main",
    });
    expect(missingPolicy.agentPolicy).toEqual({
      deny: ["exec", "write", "edit", "process"],
    });
  });
});
