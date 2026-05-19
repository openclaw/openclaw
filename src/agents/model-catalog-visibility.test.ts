import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveVisibleModelCatalog } from "./model-catalog-visibility.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

describe("resolveVisibleModelCatalog", () => {
  it("can use static auth checks for gateway read-only model lists", () => {
    const authChecker = vi.fn((provider: string) => provider === "openai");
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
      providerAuthChecker: authChecker,
    });

    expect(authChecker).toHaveBeenNthCalledWith(1, "anthropic");
    expect(authChecker).toHaveBeenNthCalledWith(2, "openai");
    expect(authChecker).toHaveBeenCalledTimes(2);
    expect(result).toEqual([{ provider: "openai", id: "gpt-test", name: "GPT Test" }]);
  });

  it("limits visible catalog to provider wildcard entries after default discovery", () => {
    const authChecker = vi.fn((provider: string) => provider !== "blocked");
    const catalog: ModelCatalogEntry[] = [
      { provider: "anthropic", id: "claude-test", name: "Claude Test" },
      { provider: "openai-codex", id: "gpt-codex-test", name: "GPT Codex Test" },
      { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
      { provider: "blocked", id: "blocked-test", name: "Blocked Test" },
    ];

    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/*": {},
            "openai-codex/*": {},
            "blocked/*": {},
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveVisibleModelCatalog({
      cfg,
      catalog,
      defaultProvider: "anthropic",
      runtimeAuthDiscovery: true,
      providerAuthChecker: authChecker,
    });

    expect(authChecker).toHaveBeenNthCalledWith(1, "anthropic");
    expect(authChecker).toHaveBeenNthCalledWith(2, "openai-codex");
    expect(authChecker).toHaveBeenNthCalledWith(3, "vllm");
    expect(authChecker).toHaveBeenNthCalledWith(4, "blocked");
    expect(authChecker).toHaveBeenCalledTimes(4);
    expect(result).toEqual([
      { provider: "openai-codex", id: "gpt-codex-test", name: "GPT Codex Test" },
      { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
    ]);
  });

  it("does not broaden visibility when selected providers have no catalog rows", () => {
    const authChecker = vi.fn(() => true);

    const cfg = {
      agents: {
        defaults: {
          models: {
            "vllm/*": {},
          },
        },
      },
    } as OpenClawConfig;

    const result = resolveVisibleModelCatalog({
      cfg,
      catalog: [{ provider: "anthropic", id: "claude-test", name: "Claude Test" }],
      defaultProvider: "anthropic",
      runtimeAuthDiscovery: true,
      providerAuthChecker: authChecker,
    });

    expect(authChecker).toHaveBeenCalledWith("anthropic");
    expect(authChecker).toHaveBeenCalledTimes(1);
    expect(result).toEqual([]);
  });

  it("scopes visibility to agents.list[<agentId>].modelAllowlist when agentId is provided", () => {
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
          { id: "writer", modelAllowlist: { "anthropic/claude-sonnet-4-6": {} } },
          {
            id: "coder",
            modelAllowlist: {
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

  it("falls back to defaults visibility when an agent has no per-agent modelAllowlist record", () => {
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
