import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { withInstallationTarget } from "../../infra/installation-target-context.js";
import * as gatewayCliShim from "../../infra/openclaw-cli-shim.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

let host: Awaited<ReturnType<typeof createAdmittedHostCapabilityTestFixture>> | undefined;
async function createHost(
  config: OpenClawConfig,
  options?: Parameters<typeof createAdmittedHostCapabilityTestFixture>[1],
) {
  host = await createAdmittedHostCapabilityTestFixture(
    {
      runId: "environment",
      agentId: "main",
      sessionKey: "agent:main:environment",
      config,
    },
    options,
  );
  return host.hostCapabilities;
}

afterEach(() => {
  host?.closeHost();
  host?.closeAdmission();
  host = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setActiveNodeContexts([]);
  resetAgentRunRegistryForTest();
});

it("keeps host context reads current and closure-bound", async () => {
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  const config = { tools: { github: { profileId: "ghp_11111111111111111111111111111111" } } };
  const target = { stateDir: "/state", configPath: "/config", defaultWorkspaceDir: "/workspace" };
  const { preparedEnvironment, activeComputerContext } = await withInstallationTarget(target, () =>
    createHost(config, {
      operatorAuthority: createAdmittedRunOperatorAuthority({
        profileId: "requester",
        scopes: ["operator.read"],
        assertCurrent: () => {},
      }),
    }),
  );
  expect(preparedEnvironment?.()).toMatchObject({
    credentialScrubEnv: { GH_TOKEN: "", GITHUB_TOKEN: "" },
    localIdentityEnv: expect.objectContaining({ GH_CONFIG_DIR: expect.any(String) }),
    managedLocalIdentity: true,
    hostExecutionRequired: true,
    localProcessEnv: {
      OPENCLAW_STATE_DIR: "/state",
      OPENCLAW_CONFIG_PATH: "/config",
      OPENCLAW_WORKSPACE_DIR: "/workspace",
    },
  });
  expect(Object.isFrozen(preparedEnvironment?.().localProcessEnv)).toBe(true);
  for (const nodeId of ["mac-a", "mac-b"]) {
    setActiveNodeContexts([{ nodeId: "shared-mac" }, { nodeId, profileId: "requester" }]);
    expect(activeComputerContext?.()).toBe(
      `Current active computer (latest reported app/system input, not message origin): active_node=${nodeId} active_node_identity=requester`,
    );
  }
  setActiveNodeContexts([
    { nodeId: "shared-mac" },
    { nodeId: "mac-b", profileId: "requester", isCurrent: () => false },
  ]);
  expect(activeComputerContext?.()).toBe(
    "Current active computer (latest reported app/system input, not message origin): active_node=unknown active_node_identity=requester",
  );
  host!.closeHost();
  expect(() => preparedEnvironment?.()).toThrow("no longer active");
  expect(() => activeComputerContext?.()).toThrow("no longer active");
});

it("snapshots the inherited tool PATH independently of identity", async () => {
  vi.spyOn(gatewayCliShim, "mergeGatewayAgentCliPath").mockImplementation((configured) => [
    "/fixture/cli",
    ...(configured ?? []),
  ]);
  vi.stubEnv("PATH", ["/fixture/system", "/fixture/global"].join(path.delimiter));
  const config: OpenClawConfig = {
    tools: {
      exec: { pathPrepend: [" /fixture/global ", "/fixture/global", ""] },
    },
    agents: { entries: { main: { tools: { exec: {} } } } },
  };
  const { preparedEnvironment } = await createHost(config);
  config.tools!.exec!.pathPrepend = ["/mutated"];
  vi.stubEnv("PATH", "/mutated-process");
  const environment = preparedEnvironment?.();
  expect(environment?.localToolEnv).toEqual({
    PATH: ["/fixture/cli", "/fixture/global", "/fixture/system"].join(path.delimiter),
  });
  expect(environment?.localToolPathPrepend).toEqual(["/fixture/cli", "/fixture/global"]);
  expect(environment?.localProcessEnv).toBeUndefined();
  expect(environment?.localIdentityEnv).toEqual({});
  expect(environment?.hostExecutionRequired).toBeUndefined();
  expect(Object.isFrozen(environment?.localToolEnv)).toBe(true);
  expect(Object.isFrozen(environment?.localToolPathPrepend)).toBe(true);
  host!.closeHost();
  expect(() => preparedEnvironment?.()).toThrow("no longer active");
});
