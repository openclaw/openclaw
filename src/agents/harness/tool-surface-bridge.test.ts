// Covers runtime config selection for the agent tool surface.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAgentHarnessToolSurfaceRuntime } from "./tool-surface-bridge.js";

describe("agent harness tool surface runtime config", () => {
  afterEach(() => {
    resetConfigRuntimeState();
  });

  it("applies Tool Search defaults on top of the resolved runtime snapshot", () => {
    const sourceConfig = {
      agents: {
        defaults: {
          experimental: {
            localModelLean: true,
          },
        },
      },
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                apiKey: {
                  source: "exec",
                  provider: "vault",
                  id: "tavily/api-key",
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const runtimeConfig = {
      ...sourceConfig,
      plugins: {
        entries: {
          tavily: {
            config: {
              webSearch: {
                apiKey: "tvly-runtime-resolved", // pragma: allowlist secret
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const runtime = createAgentHarnessToolSurfaceRuntime({
      agentId: "main",
      config: sourceConfig,
      executeTool: vi.fn(),
      modelToolsEnabled: true,
    });

    expect(runtime.config?.tools?.toolSearch).toEqual({
      enabled: true,
      mode: "tools",
      searchDefaultLimit: 5,
      maxSearchLimit: 10,
    });
    expect(runtime.config?.plugins?.entries?.tavily?.config).toMatchObject({
      webSearch: {
        apiKey: "tvly-runtime-resolved",
      },
    });
    expect(sourceConfig.plugins?.entries?.tavily?.config).toMatchObject({
      webSearch: {
        apiKey: {
          source: "exec",
          provider: "vault",
          id: "tavily/api-key",
        },
      },
    });
  });
});
