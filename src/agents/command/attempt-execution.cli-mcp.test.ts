import fs from "node:fs/promises";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { disposeAllSessionMcpRuntimes } from "../agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agent-bundle-mcp-manager.test-support.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServer,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { requireMcpConfigPath } from "../cli-runner/bundle-mcp.test-support.js";
import "../cli-runner/prepare.runtime.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "../cli-runner/prepare.test-support.js";
import type { PreparedCliRunContext } from "../cli-runner/types.js";
import * as mcpTransport from "../mcp-transport.js";
import {
  makeRunAgentAttemptParams,
  makeSessionEntry,
} from "./attempt-execution.cli.test-support.js";
import { runAgentAttempt } from "./attempt-execution.js";

const executePreparedCliRun = vi.hoisted(() => vi.fn());
// mock-isolation: Capture the serialized CLI input without starting a provider process.
vi.mock("../cli-runner/execute.runtime.js", () => ({ executePreparedCliRun }));

describe("CLI attempt session MCP overrides", () => {
  let root: string;
  const servers: Server[] = [];
  let overlays: Array<Record<string, unknown>>;

  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterAll(async () => {
      try {
        await cleanupSessionStateForTest({ stateDir: root });
        cleanup();
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  beforeAll(() => {
    root = tempDirs.make("openclaw-cli-session-mcp-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("HOME", root);
  });

  afterEach(async () => {
    await disposeAllSessionMcpRuntimes();
    await Promise.all(servers.splice(0).map((server) => server.close()));
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    overlays = [];
    setActivePluginRegistry(createEmptyPluginRegistry());
    await bindSessionMcpRuntimeTestScheduler();
    // Keep discovery and serialization real; only the external MCP transport is in memory.
    vi.spyOn(mcpTransport, "resolveMcpTransport").mockImplementation(() => {
      const [client, transport] = InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: "session-override-proof", version: "1" },
        {
          capabilities: { tools: {} },
        },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "read_docs", inputSchema: { type: "object" } }],
      }));
      void server.connect(transport);
      servers.push(server);
      return {
        transport: client,
        description: "session override fixture",
        transportType: "streamable-http",
        connectionTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
        supportsParallelToolCalls: true,
      };
    });
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          bundleMcp: true,
          bundleMcpMode: "claude-config-file",
          config: {
            command: "claude",
            args: ["--print"],
            output: "text",
            input: "arg",
            sessionMode: "none",
          },
        },
      ],
    });
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      getActiveMcpLoopbackRuntime: () => ({
        port: 31783,
        ownerToken: "loopback-owner-token",
        nonOwnerToken: "loopback-non-owner-token",
      }),
      ensureMcpLoopbackServer: createTestMcpLoopbackServer,
      createMcpLoopbackServerConfig: createTestMcpLoopbackServerConfig,
      mintMcpLoopbackClientGrant: createTestMcpLoopbackClientGrant,
      bindMcpLoopbackClientGrantAdmission: () => true,
      revokeMcpLoopbackClientGrant: () => true,
      resolveMcpLoopbackPolicyTools: () => ({ agentId: "main", tools: [] }),
      resolveMcpLoopbackScopedTools: () => ({ agentId: "main", tools: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    executePreparedCliRun.mockReset();
    executePreparedCliRun.mockImplementation(async (context: PreparedCliRunContext) => {
      const args = context.preparedBackend.backend.args;
      expect(args).toContain("--strict-mcp-config");
      const overlay = JSON.parse(await fs.readFile(requireMcpConfigPath(args), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      overlays.push(overlay.mcpServers);
      return { text: "done" };
    });
  });

  it.each([
    { globalEnabled: false, sessionEnabled: true, expectedEnabled: true },
    { globalEnabled: true, sessionEnabled: false, expectedEnabled: false },
    { globalEnabled: true, sessionEnabled: undefined, expectedEnabled: true },
    { globalEnabled: false, sessionEnabled: undefined, expectedEnabled: false },
  ])(
    "serializes global=$globalEnabled session=$sessionEnabled as enabled=$expectedEnabled",
    async ({ globalEnabled, sessionEnabled, expectedEnabled }) => {
      const sessionEntry: SessionEntry = makeSessionEntry(
        "session-mcp",
        sessionEnabled !== undefined
          ? { toolOverrides: { mcpServers: { docs: sessionEnabled } } }
          : {},
      );
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: { defaults: { skipBootstrap: true } },
        skills: { load: { watch: false } },
        mcp: {
          servers: {
            docs: {
              enabled: globalEnabled,
              transport: "streamable-http",
              url: "https://mcp.example.test/docs",
            },
          },
        },
      };
      const params = makeRunAgentAttemptParams({
        agentDir: path.join(root, "agents", "main", "agent"),
        workspaceDir: root,
        sessionEntry,
        sessionKey: "agent:main:main",
        providerOverride: "claude-cli",
        modelOverride: "sonnet",
        cfg,
        skillsSnapshot: { prompt: "", skills: [] },
        preparedRunAdmission: prepareSystemAgentRunAdmission(
          cfg,
          "run-session-mcp",
          "main",
          "cli-session-mcp-test",
        ),
      });
      try {
        const result = await runAgentAttempt(params);
        expect(result.payloads).toEqual([expect.objectContaining({ text: "done" })]);
        expect(overlays).toHaveLength(1);
        expect(Object.hasOwn(overlays[0]!, "docs")).toBe(expectedEnabled);
        if (expectedEnabled) {
          expect(overlays[0]!.docs).toMatchObject({
            type: "http",
            url: "https://mcp.example.test/docs",
          });
        }
      } finally {
        params.preparedRunAdmission?.close();
      }
    },
  );
});
