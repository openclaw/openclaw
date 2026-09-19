// Memory Core tests cover the embedding provider requirement slice of the manager cache key.
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveMemoryEmbeddingProviderRequirement,
  type MemoryEmbeddingProviderRequirement,
} from "./manager-provider-lifecycle.js";
import { resolveMemoryIndexManagerCacheKey } from "./manager-registry.js";

const SECRET_API_KEY = "sk-requirement-fixture-value";

function createCfg(params: {
  workspaceDir: string;
  baseUrl: string;
  withApiKey?: boolean;
  provider?: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: { workspace: params.workspaceDir },
      list: [{ id: "main", default: true }],
    },
    memory: {
      search: {
        provider: params.provider ?? "openai-compatible",
        model: "text-embedding-bge-m3",
      },
    },
    models: {
      providers: {
        "openai-compatible": {
          api: "openai-responses",
          baseUrl: params.baseUrl,
          ...(params.withApiKey ? { apiKey: SECRET_API_KEY } : {}),
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function resolveRequirement(params: {
  state: OpenClawTestState;
  baseUrl: string;
  withApiKey?: boolean;
  provider?: string;
}): MemoryEmbeddingProviderRequirement {
  const cfg = createCfg({
    workspaceDir: params.state.workspaceDir,
    baseUrl: params.baseUrl,
    withApiKey: params.withApiKey,
    provider: params.provider,
  });
  const settings = resolveMemorySearchConfig(cfg, "main");
  if (!settings) {
    throw new Error("expected resolved memory search settings");
  }
  return resolveMemoryEmbeddingProviderRequirement({ cfg, agentId: "main", settings });
}

function cacheKeyFor(params: {
  state: OpenClawTestState;
  settings: ResolvedMemorySearchConfig;
  requirement: MemoryEmbeddingProviderRequirement;
}): string {
  return resolveMemoryIndexManagerCacheKey({
    agentId: "main",
    workspaceDir: params.state.workspaceDir,
    settings: params.settings,
    providerRequirement: params.requirement,
    purpose: "default",
  });
}

describe("memory embedding provider requirement", () => {
  let state: OpenClawTestState | undefined;

  beforeAll(async () => {
    state = await createOpenClawTestState({
      prefix: "openclaw-mem-requirement-",
      layout: "state-only",
    });
  });

  afterAll(async () => {
    await state?.cleanup();
  });

  it("carries the adapter's provider config slice so endpoint changes rebuild the manager", () => {
    if (!state) {
      throw new Error("expected test state");
    }
    const settings = resolveMemorySearchConfig(
      createCfg({ workspaceDir: state.workspaceDir, baseUrl: "http://127.0.0.1:9001/v1" }),
      "main",
    );
    if (!settings) {
      throw new Error("expected resolved memory search settings");
    }
    const first = resolveRequirement({ state, baseUrl: "http://127.0.0.1:9001/v1" });
    const second = resolveRequirement({ state, baseUrl: "http://127.0.0.1:9002/v1" });

    expect(first.mode).toBe("required");
    expect(first.indexIdentity).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9001/v1",
      model: "text-embedding-bge-m3",
      headers: { accept: "application/json", "content-type": "application/json" },
    });
    expect(second.indexIdentity).toEqual({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9002/v1",
      model: "text-embedding-bge-m3",
      headers: { accept: "application/json", "content-type": "application/json" },
    });
    expect(first).not.toEqual(second);

    // The requirement is the only cache-key input that sees models.providers,
    // so the endpoint change must surface through it, not through settings.
    const keys = new Set([
      cacheKeyFor({ state, settings, requirement: first }),
      cacheKeyFor({ state, settings, requirement: second }),
    ]);
    expect(keys.size).toBe(2);
  });

  it("keeps the requirement stable for identical provider config", () => {
    if (!state) {
      throw new Error("expected test state");
    }
    expect(resolveRequirement({ state, baseUrl: "http://127.0.0.1:9001/v1" })).toEqual(
      resolveRequirement({ state, baseUrl: "http://127.0.0.1:9001/v1" }),
    );
  });

  it("keeps auth material out of the requirement fingerprint", () => {
    if (!state) {
      throw new Error("expected test state");
    }
    const requirement = resolveRequirement({
      state,
      baseUrl: "http://127.0.0.1:9001/v1",
      withApiKey: true,
    });

    expect(requirement.mode).toBe("required");
    expect(requirement.indexIdentity).toBeDefined();
    expect(JSON.stringify(requirement.indexIdentity)).not.toContain(SECRET_API_KEY);
  });

  it("stays fts-only without an index identity when embeddings are disabled", () => {
    if (!state) {
      throw new Error("expected test state");
    }
    const requirement = resolveRequirement({
      state,
      baseUrl: "http://127.0.0.1:9001/v1",
      provider: "none",
    });

    expect(requirement).toEqual({ mode: "fts-only", provider: "none" });
    expect(requirement.indexIdentity).toBeUndefined();
  });
});
