import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import * as gatewayCliShim from "../../infra/openclaw-cli-shim.js";
import { createAdmittedHostCapabilityTestFixture } from "./host-capability.test-support.js";

afterEach(() => {
  vi.unstubAllEnvs();
  resetAgentRunRegistryForTest();
});

describe("prepared harness tool environment", () => {
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
