import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { withInstallationTarget } from "../../infra/installation-target-context.js";
import * as gatewayCliShim from "../../infra/openclaw-cli-shim.js";
import { createAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import * as localGitHub from "../github-local-environment.js";
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

  it("binds local GitHub preparation to the exact admitted host lifetime", async () => {
    const prepare = vi
      .spyOn(localGitHub, "prepareLocalGitHubEnvironment")
      .mockImplementation(async (params) => {
        params.assertCurrent();
        return undefined;
      });
    const host = await createAdmittedHostCapabilityTestFixture({
      runId: "local-github",
      agentId: "main",
      sessionKey: "agent:main:local-github",
      config: {},
    });
    try {
      const request = { assertCurrent: vi.fn(), signal: new AbortController().signal };
      await host.hostCapabilities.prepareLocalCommandEnvironment?.(request);
      const captured = prepare.mock.calls[0]![0];
      expect(captured.admittedRunContext).toBe(host.admittedRunContext);
      expect(request.assertCurrent).toHaveBeenCalledOnce();
      host.closeHost();
      expect(captured.signal.aborted).toBe(true);
      expect(() => captured.assertCurrent()).toThrow("no longer active");
      await expect(host.hostCapabilities.prepareLocalCommandEnvironment?.(request)).rejects.toThrow(
        "no longer active",
      );
    } finally {
      host.closeHost();
      host.closeAdmission();
      prepare.mockRestore();
    }
  });

  it.each([
    {
      name: "retained policy",
      sandboxAgentId: "policy",
      expected: ["/fixture/cli", "/fixture/policy", "/fixture/system", "/fixture/global"],
    },
    {
      name: "Gateway shim with blank agent override",
      agentPrepend: [" ", ""],
      expected: undefined,
    },
    {
      name: "Gateway shim with inherited global prefix",
      expected: ["/fixture/cli", "/fixture/global", "/fixture/system"],
    },
  ])(
    "snapshots the $name tool PATH independently of identity",
    async ({ agentPrepend, sandboxAgentId, expected }) => {
      const merge = vi
        .spyOn(gatewayCliShim, "mergeGatewayAgentCliPath")
        .mockImplementation((configured) => ["/fixture/cli", ...(configured ?? [])]);
      vi.stubEnv("PATH", ["/fixture/system", "/fixture/global"].join(path.delimiter));
      const config: NonNullable<
        Parameters<typeof createAdmittedHostCapabilityTestFixture>[0]["config"]
      > = {
        tools: {
          exec: { pathPrepend: [" /fixture/global ", "/fixture/global", ""] },
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
