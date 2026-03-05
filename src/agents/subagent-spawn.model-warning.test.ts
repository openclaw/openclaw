import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSubagentRegistryForTests } from "./subagent-registry.js";

const callGatewayMock = vi.fn();

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: { mainKey: "main", scope: "per-sender" },
      agents: { defaults: { workspace: os.tmpdir() } },
    }),
  };
});

vi.mock("./subagent-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-registry.js")>();
  return {
    ...actual,
    countActiveRunsForSession: () => 0,
    registerSubagentRun: () => {},
  };
});

vi.mock("./subagent-announce.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./subagent-announce.js")>();
  return {
    ...actual,
    buildSubagentSystemPrompt: () => "system-prompt",
  };
});

vi.mock("./agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-scope.js")>();
  return {
    ...actual,
    resolveAgentWorkspaceDir: () => path.join(os.tmpdir(), "agent-workspace"),
  };
});

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({ hasHooks: () => false }),
}));

const loadModelCatalogMock = vi.fn();
vi.mock("./model-catalog.js", () => ({
  loadModelCatalog: (...args: unknown[]) => loadModelCatalogMock(...args),
}));

import { splitModelRef, spawnSubagentDirect } from "./subagent-spawn.js";

function setupGatewayMock() {
  callGatewayMock.mockImplementation(async (opts: { method?: string; params?: unknown }) => {
    if (opts.method === "sessions.patch") {
      return { ok: true };
    }
    if (opts.method === "sessions.delete") {
      return { ok: true };
    }
    if (opts.method === "agent") {
      return { runId: "run-1" };
    }
    return {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSubagentRegistryForTests();
  loadModelCatalogMock.mockResolvedValue([
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "xai", id: "grok-4-1-fast" },
  ]);
});

describe("splitModelRef", () => {
  it("parses provider/model from a slash-separated ref", () => {
    expect(splitModelRef("google/gemini-3.1-flash-lite-preview")).toEqual({
      provider: "google",
      model: "gemini-3.1-flash-lite-preview",
    });
  });

  it("parses xai/grok-4-1-fast", () => {
    expect(splitModelRef("xai/grok-4-1-fast")).toEqual({
      provider: "xai",
      model: "grok-4-1-fast",
    });
  });

  it("returns model only when no slash is present", () => {
    expect(splitModelRef("gemini")).toEqual({
      provider: undefined,
      model: "gemini",
    });
  });

  it("returns undefined fields for empty/undefined input", () => {
    expect(splitModelRef(undefined)).toEqual({ provider: undefined, model: undefined });
    expect(splitModelRef("")).toEqual({ provider: undefined, model: undefined });
    expect(splitModelRef("  ")).toEqual({ provider: undefined, model: undefined });
  });
});

describe("spawnSubagentDirect model warning", () => {
  it("sets modelWarning when model override is not in catalog", async () => {
    setupGatewayMock();

    const result = await spawnSubagentDirect(
      {
        task: "test task",
        model: "google/gemini-3.1-flash-lite-preview",
      },
      {
        agentSessionKey: "agent:main:session:test",
        agentChannel: "tui",
        requesterAgentIdOverride: "main",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.modelApplied).toBe(true);
    expect(result.modelWarning).toBeDefined();
    expect(result.modelWarning).toContain("not in the runtime model catalog");
  });

  it("does not set modelWarning when model is in catalog", async () => {
    setupGatewayMock();

    const result = await spawnSubagentDirect(
      {
        task: "test task",
        model: "xai/grok-4-1-fast",
      },
      {
        agentSessionKey: "agent:main:session:test",
        agentChannel: "tui",
        requesterAgentIdOverride: "main",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.modelApplied).toBe(true);
    expect(result.modelWarning).toBeUndefined();
  });

  it("does not set modelWarning when no model override is provided", async () => {
    setupGatewayMock();

    const result = await spawnSubagentDirect(
      {
        task: "test task",
      },
      {
        agentSessionKey: "agent:main:session:test",
        agentChannel: "tui",
        requesterAgentIdOverride: "main",
      },
    );

    expect(result.status).toBe("accepted");
    expect(result.modelWarning).toBeUndefined();
  });
});
