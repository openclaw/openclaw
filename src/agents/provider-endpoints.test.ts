import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../config/config.js";
import { resolveProviderEndpointConfig } from "./provider-endpoints.js";

function makeConfig(params: {
  endpointStrategy?: "ordered" | "health";
  endpoints?: Array<{
    id?: string;
    baseUrl: string;
    priority?: number;
    healthUrl?: string;
  }>;
}): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://primary.example/v1",
          apiKey: "test-key",
          models: [],
          endpointStrategy: params.endpointStrategy,
          endpoints: (params.endpoints ?? []).map((entry) => ({
            id: entry.id,
            baseUrl: entry.baseUrl,
            priority: entry.priority,
            health: entry.healthUrl ? { url: entry.healthUrl } : undefined,
          })),
        },
      },
    },
  } as OpenClawConfig;
}

describe("provider endpoint resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("selects the first healthy endpoint by priority", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const cfg = makeConfig({
      endpointStrategy: "health",
      endpoints: [
        {
          id: "spark-fail",
          baseUrl: "http://spark-fail.lan:11434/v1",
          priority: 0,
          healthUrl: "http://spark-fail.lan:11434/api/tags",
        },
        {
          id: "mac-fail",
          baseUrl: "http://127.0.0.2:11434/v1",
          priority: 10,
          healthUrl: "http://127.0.0.2:11434/api/tags",
        },
      ],
    });

    const resolved = await resolveProviderEndpointConfig({
      cfg,
      providerId: "openai",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(resolved.endpoint?.id).toBe("mac-fail");
    expect(resolved.cfg.models?.providers?.openai?.baseUrl).toBe("http://127.0.0.2:11434/v1");
  });

  it("falls back to base provider when all endpoints fail health checks", async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("spark unavailable"))
      .mockResolvedValueOnce(new Response("", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);

    const cfg = makeConfig({
      endpointStrategy: "health",
      endpoints: [
        {
          id: "spark",
          baseUrl: "http://spark.lan:11434/v1",
          priority: 0,
          healthUrl: "http://spark.lan:11434/api/tags",
        },
        {
          id: "mac",
          baseUrl: "http://127.0.0.1:11434/v1",
          priority: 10,
          healthUrl: "http://127.0.0.1:11434/api/tags",
        },
      ],
    });

    const resolved = await resolveProviderEndpointConfig({
      cfg,
      providerId: "openai",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(resolved.endpoint).toBeUndefined();
    expect(resolved.cfg.models?.providers?.openai?.baseUrl).toBe("https://primary.example/v1");
  });

  it("uses ordered strategy without health probes", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const cfg = makeConfig({
      endpointStrategy: "ordered",
      endpoints: [
        {
          id: "spark",
          baseUrl: "http://spark.lan:11434/v1",
          priority: 0,
          healthUrl: "http://spark.lan:11434/api/tags",
        },
        {
          id: "mac",
          baseUrl: "http://127.0.0.1:11434/v1",
          priority: 10,
          healthUrl: "http://127.0.0.1:11434/api/tags",
        },
      ],
    });

    const resolved = await resolveProviderEndpointConfig({
      cfg,
      providerId: "openai",
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(resolved.endpoint?.id).toBe("spark");
    expect(resolved.cfg.models?.providers?.openai?.baseUrl).toBe("http://spark.lan:11434/v1");
  });
});
