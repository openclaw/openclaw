import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { startMcpLifecycleServer } from "../agent-bundle-mcp-lifecycle.test-support.js";
import { disposeAllSessionMcpRuntimes } from "../agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agent-bundle-mcp-manager.test-support.js";
import { makeBootstrapWarn } from "../bootstrap-files.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import { createTestMcpLoopbackServer } from "../cli-runner.test-helpers.js";
import { userMcpConfig } from "../cli-runner/bundle-mcp-fixtures.test-support.js";
import { requireMcpConfigPath } from "../cli-runner/bundle-mcp.test-support.js";
import { getCliLiveSessionGeneration } from "../cli-runner/cli-live-session-registry.js";
import {
  mockCliMcpPreparation,
  setRawCliBackendForPrepareTest,
} from "../cli-runner/prepare-mcp.test-support.js";
import "../cli-runner/prepare.runtime.js";
import { resetCliRunnerPrepareTestDeps } from "../cli-runner/prepare.test-support.js";
import type { PreparedCliRunContext } from "../cli-runner/types.js";
import {
  makeRunAgentAttemptParams,
  makeSessionEntry,
} from "./attempt-execution.cli.test-support.js";
import { runAgentAttempt } from "./attempt-execution.js";

const executePreparedCliRun = vi.hoisted(() => vi.fn());
// mock-isolation: Capture the serialized CLI input without starting a provider process.
vi.mock("../cli-runner/execute.runtime.js", () => ({ executePreparedCliRun }));

describe("CLI attempt session MCP overrides", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let server: Awaited<ReturnType<typeof startMcpLifecycleServer>>;

  beforeAll(async () => {
    state = await createOpenClawTestState({ label: "cli-session-mcp" });
  });
  afterAll(() => state.cleanup());

  afterEach(async () => {
    await disposeAllSessionMcpRuntimes();
    await server.close();
    clearRuntimeConfigSnapshot();
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    await bindSessionMcpRuntimeTestScheduler();
    server = await startMcpLifecycleServer({
      toolName: "read_docs",
      text: () => "docs",
    });
    setRawCliBackendForPrepareTest({
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
    });
    mockCliMcpPreparation({
      makeBootstrapWarn,
      getCliLiveSessionGeneration,
      ensureMcpLoopbackServer: createTestMcpLoopbackServer,
      resolveMcpLoopbackPolicyTools: () => ({ agentId: "main", tools: [] }),
      resolveMcpLoopbackScopedTools: () => ({ agentId: "main", tools: [] }),
    });
    executePreparedCliRun.mockReset();
  });

  it.each([
    { globalEnabled: false, sessionEnabled: true, expectedEnabled: true },
    { globalEnabled: true, sessionEnabled: false, expectedEnabled: false },
    { globalEnabled: true, sessionEnabled: undefined, expectedEnabled: true },
    { globalEnabled: false, sessionEnabled: undefined, expectedEnabled: false },
  ])(
    "serializes global=$globalEnabled session=$sessionEnabled as enabled=$expectedEnabled",
    async ({ globalEnabled, sessionEnabled, expectedEnabled }) => {
      executePreparedCliRun.mockImplementation(async (context: PreparedCliRunContext) => {
        const args = context.preparedBackend.backend.args;
        expect(args).toContain("--strict-mcp-config");
        const { mcpServers }: { mcpServers: Record<string, unknown> } = JSON.parse(
          await fs.readFile(requireMcpConfigPath(args), "utf8"),
        );
        expect(Object.hasOwn(mcpServers, "docs")).toBe(expectedEnabled);
        if (expectedEnabled) {
          expect(mcpServers.docs).toMatchObject({
            type: "http",
            url: server.url,
          });
        }
        return { text: "done" };
      });
      const cfg = userMcpConfig(
        { docs: { enabled: globalEnabled, transport: "streamable-http", url: server.url } },
        {
          agents: { defaults: { skipBootstrap: true } },
          skills: { load: { watch: false } },
        },
      );
      setRuntimeConfigSnapshot(cfg);
      const params = makeRunAgentAttemptParams({
        agentDir: state.agentDir(),
        workspaceDir: state.stateDir,
        sessionEntry: makeSessionEntry(
          "session-mcp",
          sessionEnabled !== undefined
            ? { toolOverrides: { mcpServers: { docs: sessionEnabled } } }
            : {},
        ),
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
      } finally {
        params.preparedRunAdmission?.close();
      }
    },
  );
});
