import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listConfiguredOwnerInputs } from "./prepared-model-runtime.owner.js";
import {
  resolveRouterSafePreparedRuntimePaths,
  RouterSafePreparedRuntimePathError,
} from "./router-safe-prepared-runtime-paths.js";

const config = {
  agents: {
    entries: {
      "r-harris": {
        model: "openai/gpt-5.5",
        workspace: "/srv/openclaw/data/employee-agents/r-harris/workspace",
        agentDir: "/srv/openclaw/data/employee-agents/r-harris/agent",
      },
    },
  },
} satisfies OpenClawConfig;

describe("router-safe prepared runtime paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sanitizes published prepared-runtime owner paths for the router state root", () => {
    const paths = resolveRouterSafePreparedRuntimePaths({
      agentId: "r-harris",
      workspaceDir: "/srv/openclaw/data/employee-agents/r-harris/workspace",
      agentDir: "/srv/openclaw/data/employee-agents/r-harris/agent",
      source: "published",
      env: { OPENCLAW_STATE_DIR: "/home/openclaw/.openclaw", HOME: "/home/openclaw" },
    });

    expect(paths).toMatchObject({
      workspaceDir: "/home/openclaw/.openclaw/agents/r-harris/workspace",
      agentDir: "/home/openclaw/.openclaw/agents/r-harris/agent",
      diagnostics: {
        marker: "routerSafePreparedRuntimeOwnerPaths",
        agentId: "r-harris",
        source: "published",
        hostOnlyWorkspace: true,
        hostOnlyAgentDir: true,
      },
    });
  });

  it("fails closed with redacted diagnostics when host-only owner paths lack a safe root", () => {
    expect(() =>
      resolveRouterSafePreparedRuntimePaths({
        agentId: "r-harris",
        workspaceDir: "/srv/openclaw/data/employee-agents/r-harris/workspace",
        agentDir: "/srv/openclaw/data/employee-agents/r-harris/agent",
        source: "reply-run",
        env: { HOME: "/home/openclaw" },
      }),
    ).toThrow(RouterSafePreparedRuntimePathError);

    try {
      resolveRouterSafePreparedRuntimePaths({
        agentId: "r-harris",
        workspaceDir: "/srv/openclaw/data/employee-agents/r-harris/workspace",
        agentDir: "/srv/openclaw/data/employee-agents/r-harris/agent",
        source: "reply-run",
        env: { HOME: "/home/openclaw" },
      });
    } catch (err) {
      expect(String(err)).toContain("missing-approved-state-root");
      expect(String(err)).not.toContain("/srv/openclaw");
      expect((err as RouterSafePreparedRuntimePathError).diagnostics).toMatchObject({
        agentId: "r-harris",
        source: "reply-run",
        hostOnlyWorkspace: true,
        hostOnlyAgentDir: true,
      });
      return;
    }
    throw new Error("expected fail-closed path error");
  });

  it("sanitizes configured owner inputs so auth-triggered refresh cannot publish host-only paths", () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", "/home/openclaw/.openclaw");
    vi.stubEnv("HOME", "/home/openclaw");

    const [input] = listConfiguredOwnerInputs(config);

    expect(input).toMatchObject({
      agentId: "r-harris",
      workspaceDir: "/home/openclaw/.openclaw/agents/r-harris/workspace",
      agentDir: "/home/openclaw/.openclaw/agents/r-harris/agent",
    });
    expect(input?.workspaceDir).not.toContain("/srv/openclaw");
    expect(input?.agentDir).not.toContain("/srv/openclaw");
  });
});
