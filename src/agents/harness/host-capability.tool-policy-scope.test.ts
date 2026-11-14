import { afterEach, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import * as pluginTools from "../openclaw-plugin-tools.js";
import { createStubTool } from "../test-helpers/agent-tool-stubs.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

const KEY = "agent:main:main";
const hosts: Array<Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>>> = [];

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.closeHost();
    host.closeAdmission();
  }
  vi.restoreAllMocks();
  resetAgentRunRegistryForTest();
  clearRuntimeConfigSnapshot();
});

async function observeScoped(hostScope: "conversation" | "turn" | undefined) {
  setRuntimeConfigSnapshot({});
  let identity: ReturnType<typeof getGatewayToolCallerIdentity>;
  vi.spyOn(pluginTools, "resolveOpenClawPluginToolsForOptions").mockReturnValue([
    {
      ...createStubTool("file_fetch"),
      execute: async () => {
        identity = getGatewayToolCallerIdentity();
        return { content: [], details: {} };
      },
    },
  ]);
  const host = await createAdmittedHostCapabilityTestFixture({
    runId: `run-${hostScope ?? "unset"}`,
    agentId: "main",
    sessionId: "main-session",
    sessionKey: KEY,
    workspaceDir: "/workspace",
  });
  hosts.push(host);
  host.setToolPolicyScope(hostScope);
  // A plugin cannot claim conversation lifetime itself; only host preparation sets it.
  const pluginOptions = { toolPolicyScope: "conversation" } as Record<string, unknown>;
  const tools =
    host.hostCapabilities.createToolSurface?.({
      ...pluginOptions,
      sessionKey: KEY,
      runSessionKey: KEY,
      runtimeToolAllowlist: ["file_fetch"],
      includeCoreTools: false,
      toolConstructionPlan: {
        includeBaseCodingTools: false,
        includeShellTools: false,
        includeChannelTools: false,
        includeOpenClawTools: false,
        includePluginTools: true,
      },
    }) ?? [];
  await tools.find((tool) => tool.name === "file_fetch")?.execute("tool-call", {});
  expect(identity?.sessionEventToolsAllow).toEqual(expect.arrayContaining(["file_fetch"]));
  return identity?.sessionEventToolsAllowSessionScoped;
}

it.for([
  { hostScope: "conversation", scoped: true },
  { hostScope: "turn", scoped: undefined },
  { hostScope: undefined, scoped: undefined },
] as const)("uses the host-prepared $hostScope policy scope", async ({ hostScope, scoped }) => {
  expect(await observeScoped(hostScope)).toBe(scoped);
});
