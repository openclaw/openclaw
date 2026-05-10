import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveVisibleModelCatalog } from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createProviderAuthChecker } from "./model-provider-auth.js";

vi.mock("./model-provider-auth.js", () => ({
  createProviderAuthChecker: vi.fn(),
}));

const createProviderAuthCheckerMock = vi.mocked(createProviderAuthChecker);

describe("resolveVisibleModelCatalog", () => {
  beforeEach(() => {
    createProviderAuthCheckerMock.mockReset();
  });

  it("can use static auth checks for gateway read-only model lists", () => {
    const authChecker = vi.fn((provider: string) => provider === "openai");
    createProviderAuthCheckerMock.mockReturnValue(authChecker);
    const catalog: ModelCatalogEntry[] = [
      { provider: "anthropic", id: "claude-test", name: "Claude Test" },
      { provider: "openai", id: "gpt-test", name: "GPT Test" },
    ];
    const cfg = {} as OpenClawConfig;

    const result = resolveVisibleModelCatalog({
      cfg,
      catalog,
      defaultProvider: "openai",
      runtimeAuthDiscovery: false,
    });

    expect(createProviderAuthCheckerMock).toHaveBeenCalledTimes(1);
    const checkerOptions = createProviderAuthCheckerMock.mock.calls[0]?.[0];
    expect(checkerOptions?.cfg).toBe(cfg);
    expect(checkerOptions?.allowPluginSyntheticAuth).toBe(false);
    expect(checkerOptions?.discoverExternalCliAuth).toBe(false);
    expect(authChecker).toHaveBeenCalledWith("anthropic");
    expect(authChecker).toHaveBeenCalledWith("openai");
    expect(result).toEqual([{ provider: "openai", id: "gpt-test", name: "GPT Test" }]);
  });

  it("limits visible catalog to provider wildcard entries after default discovery", () => {
    const authChecker = vi.fn((provider: string) => provider !== "blocked");
    createProviderAuthCheckerMock.mockReturnValue(authChecker);
    const catalog: ModelCatalogEntry[] = [
      { provider: "anthropic", id: "claude-test", name: "Claude Test" },
      { provider: "openai-codex", id: "gpt-codex-test", name: "GPT Codex Test" },
      { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
      { provider: "blocked", id: "blocked-test", name: "Blocked Test" },
    ];

    const result = resolveVisibleModelCatalog({
      cfg: {
        agents: {
          defaults: {
            models: {
              "vllm/*": {},
              "openai-codex/*": {},
              "blocked/*": {},
            },
          },
        },
      } as OpenClawConfig,
      catalog,
      defaultProvider: "anthropic",
      runtimeAuthDiscovery: true,
    });

    expect(createProviderAuthCheckerMock).toHaveBeenCalled();
    expect(result).toEqual([
      { provider: "openai-codex", id: "gpt-codex-test", name: "GPT Codex Test" },
      { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
    ]);
  });

  it("does not broaden visibility when selected providers have no catalog rows", () => {
    const authChecker = vi.fn(() => true);
    createProviderAuthCheckerMock.mockReturnValue(authChecker);

    const result = resolveVisibleModelCatalog({
      cfg: {
        agents: {
          defaults: {
            models: {
              "vllm/*": {},
            },
          },
        },
      } as OpenClawConfig,
      catalog: [{ provider: "anthropic", id: "claude-test", name: "Claude Test" }],
      defaultProvider: "anthropic",
      runtimeAuthDiscovery: true,
    });

    expect(createProviderAuthCheckerMock).toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("scopes visibility to agents.list[<agentId>].models when agentId is provided", () => {
    createProviderAuthCheckerMock.mockReturnValue(vi.fn(() => true));
    const catalog: ModelCatalogEntry[] = [
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" },
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
    ];

    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "anthropic/claude-opus-4-6": {},
            "openai/gpt-5.4": {},
          },
        },
        list: [
          { id: "writer", models: { "anthropic/claude-sonnet-4-6": {} } },
          {
            id: "coder",
            models: {
              "openai/gpt-5.4": {},
              "anthropic/claude-opus-4-6": {},
            },
          },
        ],
      },
    } as OpenClawConfig;

    const writerView = resolveVisibleModelCatalog({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      runtimeAuthDiscovery: false,
      agentId: "writer",
    });
    expect(writerView.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "anthropic/claude-sonnet-4-6",
    ]);

    const coderView = resolveVisibleModelCatalog({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      runtimeAuthDiscovery: false,
      agentId: "coder",
    });
    expect(coderView.map((entry) => `${entry.provider}/${entry.id}`).toSorted()).toEqual([
      "anthropic/claude-opus-4-6",
      "openai/gpt-5.4",
    ]);

    const defaultView = resolveVisibleModelCatalog({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      runtimeAuthDiscovery: false,
    });
    expect(defaultView.map((entry) => `${entry.provider}/${entry.id}`).toSorted()).toEqual([
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.4",
    ]);
  });

  it("falls back to defaults visibility when an agent has no per-agent models record", () => {
    createProviderAuthCheckerMock.mockReturnValue(vi.fn(() => true));
    const catalog: ModelCatalogEntry[] = [
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
    ];

    const cfg = {
      agents: {
        defaults: {
          models: { "anthropic/claude-sonnet-4-6": {} },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    const result = resolveVisibleModelCatalog({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      runtimeAuthDiscovery: false,
      agentId: "main",
    });

    expect(result.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "anthropic/claude-sonnet-4-6",
    ]);
  });
});
