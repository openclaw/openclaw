import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedAcpxPluginConfig } from "../config-schema.js";

const { clientState } = vi.hoisted(() => ({
  clientState: {
    constructorArgs: [] as Array<Record<string, unknown>>,
    start: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  },
}));

vi.mock("../transport/acp-client.js", () => ({
  AcpClient: class {
    initializeResult = { protocolVersion: 1 };

    constructor(options: Record<string, unknown>) {
      clientState.constructorArgs.push(options);
    }

    start = clientState.start;
    close = clientState.close;
  },
}));

import { probeEmbeddedRuntime } from "./probe.js";

function createConfig(overrides: Partial<ResolvedAcpxPluginConfig> = {}): ResolvedAcpxPluginConfig {
  return {
    cwd: "/workspace",
    stateDir: "/workspace/state",
    permissionMode: "approve-reads",
    nonInteractivePermissions: "fail",
    pluginToolsMcpBridge: false,
    strictWindowsCmdWrapper: true,
    queueOwnerTtlSeconds: 0.1,
    mcpServers: {},
    agents: {},
    ...overrides,
  };
}

afterEach(() => {
  clientState.constructorArgs.length = 0;
  clientState.start.mockReset();
  clientState.close.mockReset();
});

describe("probeEmbeddedRuntime", () => {
  it("probes the default agent instead of the first override entry", async () => {
    const report = await probeEmbeddedRuntime(
      createConfig({
        agents: {
          claude: "broken-claude-acp",
          codex: "codex-override --acp",
        },
      }),
    );

    expect(report.ok).toBe(true);
    expect(clientState.constructorArgs[0]?.agentCommand).toBe("codex-override --acp");
    expect(report.details).toContain("agent=codex");
  });
});
