// A session-parts reload must join retired transports' cleanup outcomes instead
// of resolving while a changed server's cleanup is unconfirmed (#164642).
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { fixtureRuntime, withFixtureLeases } from "./agent-bundle-mcp-fixture.test-support.js";
import { sessionMcpRuntimeOwners } from "./agent-bundle-mcp-runtime-owner.js";
import { createSessionMcpRuntimeParts } from "./agent-bundle-mcp-runtime-parts.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

const tempDirTracker = useAutoCleanupTempDirTracker(afterEach);

type PartsParams = Parameters<typeof createSessionMcpRuntimeParts>[0];

it("joins retired cleanup failures into the reload outcome", async () => {
  const servers = {
    alpha: { url: "https://mcp.example/alpha", transport: "streamable-http" as const },
    beta: { url: "https://mcp.example/beta", transport: "streamable-http" as const },
  };
  const params: PartsParams = {
    sessionId: "reload-cleanup-join",
    sessionKey: "agent:test:reload-cleanup-join",
    workspaceDir: tempDirTracker.make("mcp-reload-cleanup-join-"),
    manifestRegistry: { plugins: [] },
    cfg: { plugins: { enabled: false }, mcp: { servers } },
  };
  const cleanupFailure = new Error("MCP runtime cleanup could not confirm closure");
  const createPart = (
    serverName: string,
    configFingerprint: string,
    joinCleanup: () => Promise<void>,
  ): SessionMcpRuntime => {
    const part = withFixtureLeases(
      fixtureRuntime(() => ({ version: 1, generatedAt: 0, servers: {}, tools: [] }), {
        sessionId: params.sessionId,
        configFingerprint,
      }),
    );
    part.joinCleanup = joinCleanup;
    return part;
  };
  const createStubPart = (
    partParams: Parameters<typeof createSessionMcpRuntimeParts>[1] extends (
      first: infer F,
    ) => unknown
      ? F
      : never,
  ) => {
    const fingerprint = partParams.configFingerprint ?? partParams.serverConfig.fingerprint;
    const part = createPart(
      partParams.serverName,
      fingerprint,
      partParams.serverName === "alpha"
        ? async () => {
            throw cleanupFailure;
          }
        : async () => {},
    );
    return Object.assign(part, {
      pluginOwned: false,
      resetStartupBackoff: () => {},
    });
  };

  const runtime = createSessionMcpRuntimeParts(params, createStubPart);
  const owner = sessionMcpRuntimeOwners.get(runtime);
  expect(owner).toBeDefined();

  // Retire alpha (unconfirmed cleanup) while beta survives unchanged, so the
  // runtime slot stays occupied and the retired cleanup outcome must surface
  // through the reload result instead of being swallowed (#164642 Rev 5).
  const nextCfg = { plugins: { enabled: false }, mcp: { servers: { beta: servers.beta } } };
  await expect(owner!.reload({ cfg: nextCfg })).rejects.toThrow(/cleanup unconfirmed/u);
  expect(owner!.hasServers()).toBe(true);
});
