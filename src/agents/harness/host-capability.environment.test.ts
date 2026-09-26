import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { withInstallationTarget } from "../../infra/installation-target-context.js";
import * as gatewayCliShim from "../../infra/openclaw-cli-shim.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

afterEach(() => {
  vi.unstubAllEnvs();
  setActiveNodeContexts([]);
  resetAgentRunRegistryForTest();
});

describe("prepared harness tool environment", () => {
  it("keeps host context reads current and closure-bound", async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const config = { tools: { github: { profileId: "ghp_11111111111111111111111111111111" } } };
    const target = { stateDir: "/state", configPath: "/config", defaultWorkspaceDir: "/workspace" };
    const host = await withInstallationTarget(target, () =>
      createAdmittedHostCapabilityTestFixture(
        {
          runId: "run-local-env",
          agentId: "main",
          sessionKey: "agent:main:session-1",
          config,
        },
        {
          operatorAuthority: createAdmittedRunOperatorAuthority({
            profileId: "requester",
            scopes: ["operator.read"],
            assertCurrent: () => {},
          }),
        },
      ),
    );
    try {
      expect(host.hostCapabilities.preparedEnvironment?.()).toMatchObject({
        credentialScrubEnv: { GH_TOKEN: "", GITHUB_TOKEN: "" },
        localIdentityEnv: expect.objectContaining({ GH_CONFIG_DIR: expect.any(String) }),
        managedLocalIdentity: true,
        localProcessEnv: {
          OPENCLAW_STATE_DIR: "/state",
          OPENCLAW_CONFIG_PATH: "/config",
          OPENCLAW_WORKSPACE_DIR: "/workspace",
        },
      });
      expect(Object.isFrozen(host.hostCapabilities.preparedEnvironment?.().localProcessEnv)).toBe(
        true,
      );
      for (const nodeId of ["mac-a", "mac-b"]) {
        setActiveNodeContexts([{ nodeId: "shared-mac" }, { nodeId, profileId: "requester" }]);
        expect(host.hostCapabilities.activeComputerContext?.()).toBe(
          `Current active computer (latest reported app/system input, not message origin): active_node=${nodeId} active_node_identity=requester`,
        );
      }
      setActiveNodeContexts([
        { nodeId: "shared-mac" },
        { nodeId: "mac-b", profileId: "requester", isCurrent: () => false },
      ]);
      expect(host.hostCapabilities.activeComputerContext?.()).toBe(
        "Current active computer (latest reported app/system input, not message origin): active_node=unknown active_node_identity=requester",
      );
      host.closeHost();
      expect(() => host.hostCapabilities.preparedEnvironment?.()).toThrow("no longer active");
      expect(() => host.hostCapabilities.activeComputerContext?.()).toThrow("no longer active");
    } finally {
      host.closeHost();
      host.closeAdmission();
    }
  });

  it.each([
    { name: "global", expected: ["/fixture/global", "/fixture/system"] },
    {
      name: "agent",
      agentPrepend: [" /fixture/agent ", "/fixture/agent"],
      expected: ["/fixture/agent", "/fixture/system", "/fixture/global"],
    },
    { name: "empty agent", agentPrepend: [], expected: undefined },
    {
      name: "retained policy",
      sandboxAgentId: "policy",
      expected: ["/fixture/policy", "/fixture/system", "/fixture/global"],
    },
    {
      name: "Gateway shim without configuration",
      noGlobalPrepend: true,
      shim: true,
      expected: undefined,
    },
    {
      name: "Gateway shim with empty agent override",
      agentPrepend: [],
      shim: true,
      expected: undefined,
    },
    {
      name: "Gateway shim with blank agent override",
      agentPrepend: [" ", ""],
      shim: true,
      expected: undefined,
    },
    {
      name: "Gateway shim with inherited global prefix",
      shim: true,
      expected: ["/fixture/cli", "/fixture/global", "/fixture/system"],
    },
    {
      name: "Gateway shim with agent prefix",
      agentPrepend: ["/fixture/agent"],
      shim: true,
      expected: ["/fixture/cli", "/fixture/agent", "/fixture/system", "/fixture/global"],
    },
  ])(
    "snapshots the $name tool PATH independently of identity",
    async ({ agentPrepend, sandboxAgentId, noGlobalPrepend, shim, expected }) => {
      const merge = vi
        .spyOn(gatewayCliShim, "mergeGatewayAgentCliPath")
        .mockImplementation((configured) => [
          ...(shim ? ["/fixture/cli"] : []),
          ...(configured ?? []),
        ]);
      vi.stubEnv("PATH", ["/fixture/system", "/fixture/global"].join(path.delimiter));
      const config: NonNullable<
        Parameters<typeof createAdmittedHostCapabilityTestFixture>[0]["config"]
      > = {
        tools: {
          exec: noGlobalPrepend
            ? {}
            : { pathPrepend: [" /fixture/global ", "/fixture/global", ""] },
        },
        agents: {
          entries: {
            main: { tools: { exec: agentPrepend ? { pathPrepend: agentPrepend } : {} } },
            policy: { tools: { exec: { pathPrepend: ["/fixture/policy"] } } },
          },
        },
      };
      const host = await createAdmittedHostCapabilityTestFixture({
        runId: "run-tool-path",
        agentId: "main",
        sessionKey: "agent:main:tool-path",
        config,
        sandboxAgentId,
      });
      try {
        config.tools!.exec!.pathPrepend = ["/mutated"];
        vi.stubEnv("PATH", "/mutated-process");
        const environment = host.hostCapabilities.preparedEnvironment?.();
        expect(environment?.localToolEnv).toEqual(
          expected ? { PATH: expected.join(path.delimiter) } : undefined,
        );
        expect(environment?.localToolPathPrepend).toEqual(
          expected ? expected.slice(0, expected.indexOf("/fixture/system")) : undefined,
        );
        expect(environment?.localProcessEnv).toBeUndefined();
        expect(environment?.localIdentityEnv).toEqual({});
        if (expected) {
          expect(Object.isFrozen(environment?.localToolEnv)).toBe(true);
          expect(Object.isFrozen(environment?.localToolPathPrepend)).toBe(true);
        }
        host.closeHost();
        expect(() => host.hostCapabilities.preparedEnvironment?.()).toThrow("no longer active");
      } finally {
        host.closeHost();
        host.closeAdmission();
        merge.mockRestore();
      }
    },
  );
});
