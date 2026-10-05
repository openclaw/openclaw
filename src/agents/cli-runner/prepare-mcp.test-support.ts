import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { resolveMcpLoopbackScopedTools } from "../../gateway/mcp-http.runtime.js";
import {
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  type createCliRunnerPrepareFixture,
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServer,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { setCliRunnerPrepareTestDeps } from "./prepare.test-support.js";

type McpProjectionParams = Parameters<typeof resolveMcpLoopbackScopedTools>[0];

/** Reuses the preparation suite's backend and lifecycle fixture for MCP admission proof. */
export function registerCliMcpPreparationTests({
  getFixture,
  createConfig,
}: {
  getFixture: () => ReturnType<typeof createCliRunnerPrepareFixture>;
  createConfig: () => OpenClawConfig;
}) {
  it("binds one live prepared admission to tool projection and the CLI MCP grant", async () => {
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    const bindMcpLoopbackClientGrantAdmission = vi.fn(() => true);
    const resolveMcpLoopbackScopedTools = vi.fn((_scope: McpProjectionParams) => ({
      agentId: "main",
      tools: [],
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
      resolveMcpLoopbackScopedTools,
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      createMcpLoopbackServerConfig: vi.fn(createTestMcpLoopbackServerConfig),
      mintMcpLoopbackClientGrant: vi.fn(createTestMcpLoopbackClientGrant),
      bindMcpLoopbackClientGrantAdmission,
    });
    const preparedRunAdmission = prepareSystemAgentRunAdmission(
      {},
      "run-prepared-mcp",
      "main",
      "cli-mcp-projection",
    );
    try {
      const context = await getFixture().prepare({
        runId: "run-prepared-mcp",
        preparedRunAdmission,
        config: createConfig(),
      });

      try {
        expect(context.params.admittedRunContext.operationalRunInstance).toBe(
          preparedRunAdmission.operationalRunInstance,
        );
        expect(resolveMcpLoopbackScopedTools.mock.calls[0]?.[0].admittedRunContext).toBe(
          context.params.admittedRunContext,
        );
        expect(getAdmittedRunDelegatedAuthority(context.params.admittedRunContext)).toBeDefined();
        expect(bindMcpLoopbackClientGrantAdmission).toHaveBeenCalledExactlyOnceWith({
          token: "loopback-token",
          runtimeOwnerToken: "loopback-owner-token",
          admittedRunContext: context.params.admittedRunContext,
        });
      } finally {
        await context.preparedBackend.cleanup?.();
      }
    } finally {
      await preparedRunAdmission.close();
    }
  });
}
