import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBundledBrowserPluginFixture } from "../../test/helpers/browser-bundled-plugin-fixture.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginLoaderCache } from "../plugins/loader.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createOpenClawCodingTools } from "./pi-tools.js";
import { resolveSandboxConfigForAgent } from "./sandbox/config.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { createPiToolsSandboxContext } from "./test-helpers/pi-tools-sandbox-context.js";

function resetPluginState() {
  clearPluginLoaderCache();
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  resetPluginRuntimeStateForTest();
}

function listToolNames(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sandboxAgentId?: string;
}): string[] {
  const workspaceDir = "/tmp/openclaw-sandbox-policy";
  const sessionKey = params.sessionKey ?? "agent:tavern:main";
  const sandboxAgentId = params.sandboxAgentId ?? params.agentId ?? "tavern";
  const sandbox = createPiToolsSandboxContext({
    workspaceDir,
    fsBridge: createHostSandboxFsBridge(workspaceDir),
    sessionKey,
    tools: resolveSandboxConfigForAgent(params.cfg, sandboxAgentId).tools,
  });
  return createOpenClawCodingTools({
    config: params.cfg,
    agentId: params.agentId,
    sessionKey,
    sandbox,
    workspaceDir,
  })
    .map((tool) => tool.name)
    .toSorted();
}

describe("pi-tools sandbox policy", () => {
  let bundledFixture: ReturnType<typeof createBundledBrowserPluginFixture> | null = null;

  beforeEach(() => {
    bundledFixture = createBundledBrowserPluginFixture();
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledFixture.rootDir);
    resetPluginState();
  });

  afterEach(() => {
    resetPluginState();
    vi.unstubAllEnvs();
    bundledFixture?.cleanup();
    bundledFixture = null;
  });

  it("re-exposes omitted sandbox tools via sandbox alsoAllow", () => {
    const names = listToolNames({
      cfg: {
        agents: {
          defaults: {
            sandbox: { mode: "all", scope: "agent" },
          },
          list: [
            {
              id: "tavern",
              tools: {
                sandbox: {
                  tools: {
                    alsoAllow: ["message", "tts"],
                  },
                },
              },
            },
          ],
        },
      } as OpenClawConfig,
    });

    expect(names).toContain("message");
    expect(names).toContain("tts");
  });

  it("re-enables default-denied sandbox tools when explicitly allowed", () => {
    const names = listToolNames({
      cfg: {
        agents: {
          defaults: {
            sandbox: { mode: "all", scope: "agent" },
          },
          list: [{ id: "tavern" }],
        },
        tools: {
          sandbox: {
            tools: {
              allow: ["browser"],
            },
          },
        },
        plugins: {
          allow: ["browser"],
        },
      } as OpenClawConfig,
    });

    expect(names).toContain("browser");
  });

  it("prefers the resolved sandbox context policy for legacy main session aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          sandbox: { mode: "all", scope: "agent" },
        },
        list: [
          {
            id: "tavern",
            default: true,
            tools: {
              sandbox: {
                tools: {
                  allow: ["browser"],
                  alsoAllow: ["message"],
                },
              },
            },
          },
        ],
      },
      plugins: {
        allow: ["browser"],
      },
    } as OpenClawConfig;

    const names = listToolNames({
      cfg,
      sessionKey: "main",
      sandboxAgentId: "tavern",
    });

    expect(names).toContain("browser");
    expect(names).toContain("message");
  });

  it("preserves allow-all semantics for allow: [] plus alsoAllow", () => {
    const names = listToolNames({
      cfg: {
        agents: {
          defaults: {
            sandbox: { mode: "all", scope: "agent" },
          },
          list: [{ id: "tavern" }],
        },
        tools: {
          sandbox: {
            tools: {
              allow: [],
              alsoAllow: ["browser"],
            },
          },
        },
        plugins: {
          allow: ["browser"],
        },
      } as OpenClawConfig,
    });

    expect(names).toContain("browser");
    expect(names).toContain("read");
  });

  it("keeps explicit sandbox deny precedence over explicit allow", () => {
    const names = listToolNames({
      cfg: {
        agents: {
          defaults: {
            sandbox: { mode: "all", scope: "agent" },
          },
          list: [{ id: "tavern" }],
        },
        tools: {
          sandbox: {
            tools: {
              allow: ["browser", "message"],
              deny: ["browser"],
            },
          },
        },
        plugins: {
          allow: ["browser"],
        },
      } as OpenClawConfig,
    });

    expect(names).not.toContain("browser");
    expect(names).toContain("message");
  });
});
