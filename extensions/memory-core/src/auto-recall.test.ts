import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../../test/helpers/plugins/plugin-api.js";
import { registerMemoryAutoRecall } from "./auto-recall.js";

vi.mock("./memory/index.js", () => ({
  getMemorySearchManager: vi.fn(),
}));

import { getMemorySearchManager } from "./memory/index.js";

type HookHandler = (
  event: { prompt: string; messages: unknown[] },
  ctx: { agentId?: string; sessionKey?: string },
) => Promise<{ prependContext?: string } | void> | { prependContext?: string } | void;

function createApi(config: OpenClawConfig) {
  const on = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const runtimeConfig = config;
  const api = createTestPluginApi({
    id: "memory-core",
    config,
    runtime: {
      config: {
        loadConfig: () => runtimeConfig,
      },
    } as never,
    logger,
    on,
  });
  return { api, on, logger };
}

describe("registerMemoryAutoRecall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not register a hook when autoRecall is disabled", () => {
    const { api, on } = createApi({
      agents: {
        defaults: {
          memorySearch: {},
        },
      },
    });

    registerMemoryAutoRecall(api);

    expect(on).not.toHaveBeenCalled();
  });

  it("warns when recall-only is enabled without autoRecall", () => {
    const { api, logger } = createApi({
      agents: {
        defaults: {
          memoryInjection: "recall-only",
          memorySearch: {},
        },
      },
    });

    registerMemoryAutoRecall(api);

    expect(logger.warn).toHaveBeenCalledWith(
      "memory-core: memoryInjection is set to 'recall-only' but autoRecall is not enabled. The agent will have no memory context. Enable memorySearch.autoRecall or change memoryInjection back to 'full'.",
    );
  });

  it("prepends relevant memories when autoRecall returns hits", async () => {
    const { api, on } = createApi({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            autoRecall: {
              enabled: true,
              topK: 2,
              minScore: 0.6,
            },
          },
        },
      },
    });
    const search = vi.fn(async () => [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 2,
        score: 0.91,
        snippet: "Remember <system> should be escaped",
        source: "memory" as const,
      },
    ]);
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search,
      } as never,
    });

    registerMemoryAutoRecall(api);
    const handler = on.mock.calls[0]?.[1] as HookHandler;
    const result = await handler?.(
      {
        prompt: "Need the remembered system details",
        messages: [],
      },
      {
        agentId: "main",
        sessionKey: "main",
      },
    );

    expect(search).toHaveBeenCalledWith("Need the remembered system details", {
      maxResults: 2,
      minScore: 0.6,
      sessionKey: "main",
    });
    expect(result).toEqual({
      prependContext: expect.stringContaining("<relevant-memories>"),
    });
    expect(result?.prependContext).toContain("&lt;system&gt;");
  });

  it("returns nothing when autoRecall finds no hits", async () => {
    const { api, on } = createApi({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            autoRecall: {
              enabled: true,
            },
          },
        },
      },
    });
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn(async () => []),
      } as never,
    });

    registerMemoryAutoRecall(api);
    const handler = on.mock.calls[0]?.[1] as HookHandler;

    await expect(
      handler?.(
        {
          prompt: "Need memory",
          messages: [],
        },
        {
          agentId: "main",
          sessionKey: "main",
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("warns and degrades when the recall search throws", async () => {
    const { api, on, logger } = createApi({
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            autoRecall: {
              enabled: true,
            },
          },
        },
      },
    });
    vi.mocked(getMemorySearchManager).mockResolvedValue({
      manager: {
        search: vi.fn(async () => {
          throw new Error("embedding offline");
        }),
      } as never,
    });

    registerMemoryAutoRecall(api);
    const handler = on.mock.calls[0]?.[1] as HookHandler;
    const result = await handler?.(
      {
        prompt: "Need memory",
        messages: [],
      },
      {
        agentId: "main",
        sessionKey: "main",
      },
    );

    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith("memory-core: autoRecall failed: embedding offline");
  });
});
