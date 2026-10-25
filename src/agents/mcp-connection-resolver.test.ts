import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayReloadPlan } from "../gateway/config-reload-plan.js";
import { createGatewayCronReconciliation } from "../gateway/server-cron-reconciled.js";
import {
  createDefaultGatewayReloadState,
  createTestCronState,
} from "../gateway/server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "../gateway/server-reload-hot.js";
import { isGatewayRestartExternallyAllowed, setGatewayRestartPolicy } from "../infra/restart.js";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { isPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { OpenClawPluginMcpServerConnectionResolver } from "../plugins/types.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { setSessionMcpRuntimeScheduler } from "./agent-bundle-mcp-manager-api.js";
import { getOrCreateSessionMcpRuntime } from "./agent-bundle-mcp-manager.test-support.js";
import { disposeAllSessionMcpRuntimes } from "./agent-bundle-mcp-tools.js";
import {
  applyMcpConnectionOverride as applyOverride,
  hashMcpResolvedConnections,
  partitionMcpServersByConnectionScope,
  redactMcpServersForFingerprint,
  resolveRequesterScopedMcpConnections,
} from "./mcp-connection-resolver.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

type RegisterResolver = (
  pluginId: string,
  serverName: string,
  resolve: OpenClawPluginMcpServerConnectionResolver["resolve"],
) => void;
function withResolvers<T>(run: (register: RegisterResolver) => T): T {
  const proof = createMcpProofPluginRegistry();
  return withPluginRuntimeRegistryScope(proof.registry, () =>
    run((pluginId, serverName, resolve) => {
      proof.apiFor(pluginId).registerMcpServerConnectionResolver({ serverName, resolve });
    }),
  );
}
function resolverRegistry(
  pluginId: string,
  serverName: string,
  resolve: Parameters<RegisterResolver>[2],
) {
  const proof = createMcpProofPluginRegistry();
  proof.apiFor(pluginId).registerMcpServerConnectionResolver({ serverName, resolve });
  return proof;
}
function remoteConfig(name: string): OpenClawConfig {
  return {
    mcp: {
      servers: {
        [name]: { transport: "streamable-http", url: `https://placeholder.invalid/${name}` },
      },
    },
  };
}
function requesterScope(sessionId: string, requesterSenderId: string) {
  return { sessionId, requesterSenderId, agentAccountId: "proof-bot", messageChannel: "telegram" };
}
function sessionRuntime(scope: ReturnType<typeof requesterScope>, cfg: OpenClawConfig) {
  return getOrCreateSessionMcpRuntime({
    ...scope,
    cfg,
    sessionKey: `agent:test:${scope.sessionId}`,
    workspaceDir: process.cwd(),
  });
}
function resolveFor(serverNames: string[], requesterSenderId?: string) {
  return resolveRequesterScopedMcpConnections({ serverNames, requesterSenderId });
}
function connection({ url, authorization }: { url: string; authorization: string }) {
  return { url, headers: { Authorization: authorization } };
}

async function startAuthenticatedMcpProofServer() {
  const addEndpoint = async (owner: string, authorization: string) => {
    const server = new McpServer({ name: `openclaw-${owner}-proof`, version: "1.0.0" });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    const endpoint = {
      owner,
      authorization,
      path: `/mcp/${owner}`,
      server,
      transport,
      requests: 0,
      streamedResponses: 0,
      toolCalls: 0,
      url: "",
    };
    server.registerTool("owner_probe", {}, async () => {
      endpoint.toolCalls += 1;
      return { content: [{ type: "text" as const, text: endpoint.owner }] };
    });
    await server.connect(transport);
    return endpoint;
  };

  const mail = await addEndpoint("mail", "Bearer test-mcp-mail-owner");
  const activeDrive = await addEndpoint("active-drive", "Bearer test-mcp-active-drive-owner");
  const endpoints = [mail, activeDrive];
  const endpointsByPath = new Map(endpoints.map((endpoint) => [endpoint.path, endpoint]));
  const server = http.createServer((request, response) => {
    const endpoint = endpointsByPath.get(request.url ?? "");
    if (!endpoint) {
      response.writeHead(404).end();
      return;
    }
    endpoint.requests += 1;
    if (request.headers.authorization !== endpoint.authorization) {
      response.writeHead(401).end();
      return;
    }
    const writeHead = response.writeHead.bind(response);
    response.writeHead = ((
      statusCode: number,
      statusMessageOrHeaders?: string | http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
      headers?: http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
    ) => {
      // Hono passes SDK response headers directly to writeHead; getHeader cannot observe them.
      const responseHeaders =
        typeof statusMessageOrHeaders === "string" ? headers : statusMessageOrHeaders;
      if (responseHeaders && !Array.isArray(responseHeaders)) {
        const contentType = Object.entries(responseHeaders).find(
          ([name]) => name.toLowerCase() === "content-type",
        )?.[1];
        if (typeof contentType === "string" && contentType.includes("text/event-stream")) {
          endpoint.streamedResponses += 1;
        }
      }
      return typeof statusMessageOrHeaders === "string"
        ? writeHead(statusCode, statusMessageOrHeaders, headers)
        : writeHead(statusCode, statusMessageOrHeaders);
    }) as typeof response.writeHead;
    void endpoint.transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500).end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("MCP proof server did not acquire a loopback port");
  }
  for (const endpoint of endpoints) {
    endpoint.url = `http://127.0.0.1:${address.port}${endpoint.path}`;
  }

  return {
    mail,
    activeDrive,
    close: async () => {
      await Promise.all(endpoints.map((endpoint) => endpoint.server.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mcp connection resolver helpers", () => {
  it("partitions static vs requester-scoped servers deterministically", () => {
    withResolvers((register) => {
      register("test-plugin", "user-mail", async () => ({ url: "https://example.test" }));
      const partition = partitionMcpServersByConnectionScope({
        ["__proto__"]: { command: "proto" },
        shared: { command: "true" },
        calendar: { auth: "oauth", oauth: { identity: "per-requester" } },
        "user-mail": { transport: "streamable-http" },
        zebra: { command: "z" },
      });
      expect(Object.keys(partition.staticServers)).toEqual(["__proto__", "shared", "zebra"]);
      expect(Object.hasOwn(partition.staticServers, "__proto__")).toBe(true);
      expect(partition).toMatchObject({
        staticServers: { ["__proto__"]: { command: "proto" } },
        requesterScopedServerNames: ["calendar", "user-mail"],
        oauthRequesterServerNames: ["calendar"],
        resolverRequesterServerNames: ["user-mail"],
      });
    });
  });

  it("resolves registrations from the authoritative request registry", async () => {
    const root = resolverRegistry("root-mail", "root-mail", async () => ({
      url: "https://root.example.test",
    }));
    const scoped = resolverRegistry("scoped-mail", "scoped-mail", async () => ({
      url: "https://scoped.example.test",
    }));
    setActivePluginRegistry(root.registry);

    await withPluginRuntimeRegistryScope(scoped.registry, async () => {
      await expect(resolveFor(["scoped-mail"], "requester")).resolves.toEqual(
        new Map([["scoped-mail", { url: "https://scoped.example.test" }]]),
      );
    });
    await expect(resolveFor(["scoped-mail"], "requester")).resolves.toEqual(new Map());
  });

  it("revokes MCP credentials during a full gateway plugin-disable replacement", async () => {
    setRuntimeConfigSnapshot({ plugins: { entries: { "startup-mail": { enabled: true } } } });
    const scheduler = createTestGatewayScheduler();
    onTestFinished(() => scheduler.stop());
    await setSessionMcpRuntimeScheduler(scheduler);
    const proof = await startAuthenticatedMcpProofServer();
    const previousExternalRestartPolicy = isGatewayRestartExternallyAllowed();

    try {
      // Keep provider discovery outside the MCP credential-revocation fixture.
      vi.spyOn(
        await import("./prepared-model-runtime.js"),
        "refreshPreparedModelRuntimeSnapshots",
      ).mockResolvedValue(undefined);
      vi.spyOn(await import("./context.js"), "refreshContextWindowCache").mockResolvedValue(
        undefined,
      );
      const previous = resolverRegistry("startup-mail", "user-mail", async () =>
        connection(proof.mail),
      );
      setActivePluginRegistry(previous.registry);

      const sessionId = "gateway-plugin-disable-mcp-proof";
      const previousScope = requesterScope(sessionId, "existing-before-disable");
      const previousRuntime = await sessionRuntime(previousScope, remoteConfig("user-mail"));
      await expect(previousRuntime.callTool("user-mail", "owner_probe", {})).resolves.toMatchObject(
        { content: [{ type: "text", text: "mail" }] },
      );
      expect(proof.mail.streamedResponses).toBeGreaterThanOrEqual(3);

      const reloadPlan = buildGatewayReloadPlan(["plugins.entries.startup-mail.enabled"]);

      const replacement = resolverRegistry("active-drive", "user-drive", async () =>
        connection(proof.activeDrive),
      );
      expect(isPluginRegistryRetired(previous.registry)).toBe(false);

      let gatewayState = createDefaultGatewayReloadState({
        hooksConfig: null,
        hookClientIpConfig: { trustedProxies: undefined, allowRealIpFallback: false },
        cronState: createTestCronState({
          storePath: "/tmp/openclaw-mcp-gateway-reload-proof-cron",
        }),
      });
      const reloadLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const requestRecoveryRestart = vi.fn(() => ({ status: "failed" as const }));
      const nextConfig: OpenClawConfig = {
        ...remoteConfig("user-drive"),
        plugins: {
          entries: {
            "startup-mail": { enabled: false },
            "active-drive": { enabled: true },
          },
        },
      };
      let attachedRegistry = previous.registry;
      const runtime = {
        operationId: "mcp-plugin-disable",
        generation: 1,
        pluginIds: ["active-drive", "startup-mail"],
        sourceDigests: {},
      };
      const gatewayReload = createGatewayReloadHandlers({
        scheduler,
        deps: {},
        broadcast() {},
        getState: () => gatewayState,
        getPluginRegistry: () => attachedRegistry,
        setState(nextState) {
          gatewayState = nextState;
        },
        async startChannel() {
          return new Map();
        },
        async stopChannel() {},
        releaseChannelRouteHandoffs() {},
        pruneInactiveChannelAccountState() {},
        async reloadPlugins({ commitRuntime }) {
          await commitRuntime({
            publish() {
              attachedRegistry = replacement.registry;
              setActivePluginRegistry(replacement.registry);
            },
          });
          return { restartChannels: new Set(), activeChannels: new Set(), runtime };
        },
        logHooks: reloadLog,
        logChannels: reloadLog,
        logCron: reloadLog,
        logReload: reloadLog,
        cronReconciliation: createGatewayCronReconciliation({
          port: 0,
          workspaceDir: process.cwd(),
          isClosing: () => false,
          async runHook() {},
        }),
        requestRecoveryRestart,
      });

      await expect(gatewayReload.applyHotReload(reloadPlan, nextConfig)).resolves.toEqual({
        status: "applied",
        runtime,
      });
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
      expect(isPluginRegistryRetired(previous.registry)).toBe(true);

      const legacyRequests = proof.mail.requests;
      await expect(previousRuntime.callTool("user-mail", "owner_probe", {})).rejects.toThrow(
        "bundle-mcp runtime disposed for session gateway-plugin-disable-mcp-proof",
      );
      expect(proof.mail.requests).toBe(legacyRequests);
      await expect(
        resolveFor(["user-drive", "user-mail"], "brand-new-after-disable"),
      ).resolves.toEqual(new Map([["user-drive", connection(proof.activeDrive)]]));

      const nextScope = requesterScope(
        "gateway-plugin-disable-brand-new-mcp-proof",
        "brand-new-after-disable",
      );
      const nextRuntime = await sessionRuntime(nextScope, nextConfig);
      await expect(nextRuntime.callTool("user-drive", "owner_probe", {})).resolves.toMatchObject({
        content: [{ type: "text", text: "active-drive" }],
      });
      await expect(nextRuntime.callTool("user-mail", "owner_probe", {})).rejects.toThrow();
      expect(proof.activeDrive.toolCalls).toBe(1);
      expect(proof.activeDrive.streamedResponses).toBeGreaterThanOrEqual(3);
      expect(proof.mail).toMatchObject({ requests: legacyRequests, toolCalls: 1 });
    } finally {
      await disposeAllSessionMcpRuntimes();
      await resetPreparedModelRuntimeSnapshotsForTest();
      setGatewayRestartPolicy({ allowExternal: previousExternalRestartPolicy });
      await proof.close();
    }
  });

  it("fails closed without requesterSenderId and drops null resolutions", async () => {
    await withResolvers(async (register) => {
      register("test-plugin", "user-mail", async (ctx) =>
        ctx.requesterSenderId === "ok" ? { url: "https://example.test/ok" } : null,
      );
      await expect(resolveFor(["user-mail"])).resolves.toEqual(new Map());
      await expect(resolveFor(["user-mail"], "nope")).resolves.toEqual(new Map());
      await expect(resolveFor(["user-mail"], "ok")).resolves.toEqual(
        new Map([["user-mail", { url: "https://example.test/ok" }]]),
      );
    });
  });

  it("registers resolved header and signed-URL credentials for redaction", async () => {
    await withResolvers(async (register) => {
      register("test-plugin", "user-mail", async () => ({
        url: "https://mcp.example.test/mail?sig=placeholder-signature",
        headers: { Authorization: "Bearer test-auth-token" },
      }));
      const { resetSecretRedactionRegistryForTest } =
        await import("../logging/secret-redaction-registry.test-support.js");
      resetSecretRedactionRegistryForTest();
      await resolveFor(["user-mail"], "sender");
      for (const secret of [
        "Bearer test-auth-token",
        "test-auth-token",
        "placeholder-signature",
        "https://mcp.example.test/mail?sig=placeholder-signature",
      ]) {
        expect(isSecretValueRegisteredForRedaction(secret)).toBe(true);
      }
      resetSecretRedactionRegistryForTest();
    });
  });

  it("contains per-server resolve throws without rejecting the map", async () => {
    await withResolvers(async (register) => {
      register("broken-plugin", "user-mail", async () => {
        throw new Error("Authorization: Bearer secret-token");
      });
      register("ok-plugin", "other", async () => ({ url: "https://example.test/other" }));
      const logWarn = vi
        .spyOn(await import("../logger.js"), "logWarn")
        .mockImplementation(() => {});
      await expect(resolveFor(["user-mail", "other"], "sender")).resolves.toEqual(
        new Map([["other", { url: "https://example.test/other" }]]),
      );
      expect(logWarn).toHaveBeenCalledOnce();
      const logged = JSON.stringify(logWarn.mock.calls);
      expect(logged).not.toMatch(/secret-token|Bearer|Authorization/);
    });
  });

  it("resolves stalled servers concurrently within one timeout window", async () => {
    await withResolvers(async (register) => {
      register("hang-a", "mail-a", () => new Promise(() => {}));
      register("hang-b", "mail-b", () => new Promise(() => {}));
      register("ok-plugin", "other", async () => ({ url: "https://example.test/other" }));
      vi.useFakeTimers();
      const pending = resolveFor(["mail-a", "mail-b", "other"], "sender");
      // Concurrent resolves: one timeout window covers both stalls, not two sequential waits.
      const settled = vi.fn();
      void pending.then(settled);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledOnce();
      await expect(pending).resolves.toEqual(
        new Map([["other", { url: "https://example.test/other" }]]),
      );
    });
  });

  it("uses an ephemeral keyed digest, not a plain SHA-256 of credentials", async () => {
    const connections = (headers: Record<string, string>) =>
      new Map([["mail", { url: "https://example.test/a", headers }]]);
    const a = connections({ Authorization: "Bearer test-auth-token", "X-B": "2" });
    const rotated = connections({ Authorization: "Bearer secret-token", "X-B": "2" });
    const same = connections({ "X-B": "2", Authorization: "Bearer test-auth-token" });
    const digest = hashMcpResolvedConnections(a);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMcpResolvedConnections(a)).toBe(digest);
    expect(hashMcpResolvedConnections(same)).toBe(digest);
    expect(hashMcpResolvedConnections(rotated)).not.toBe(digest);
    const plainTuples = JSON.stringify([
      [
        "mail",
        "https://example.test/a",
        Object.entries({ Authorization: "Bearer test-auth-token", "X-B": "2" }),
      ],
    ]);
    const plainSha = createHash("sha256").update(plainTuples).digest("hex");
    expect(digest).not.toBe(plainSha);
  });

  it("normalizes incompatible static fields when applying connection overrides", () => {
    const retained = {
      transport: "stdio",
      type: "stdio",
      auth: "oauth",
      oauth: { scope: "mail" },
      toolFilter: { include: ["send"] },
    };
    const servers = {
      "user-mail": {
        ...retained,
        command: "/bin/echo",
        args: ["serve"],
        url: "https://placeholder.example",
        headers: { Authorization: "test-auth-token" },
      },
    };
    const redacted = redactMcpServersForFingerprint(servers, new Set(["user-mail"]));
    expect(redacted).toEqual({
      "user-mail": { ...retained, connection: "requester-scoped" },
    });

    const applied = applyOverride(servers["user-mail"], {
      url: "https://live.example/user",
      headers: { Authorization: "Bearer test-auth-token" },
    });
    expect(applied).toEqual({
      transport: "streamable-http",
      url: "https://live.example/user",
      headers: { Authorization: "Bearer test-auth-token" },
      toolFilter: { include: ["send"] },
    });
    expect(servers["user-mail"].headers).toEqual({ Authorization: "test-auth-token" });

    const url = "https://live.example/sse";
    expect(
      applyOverride({ transport: "sse", toolFilter: { include: ["x"] } }, { url }),
    ).toMatchObject({ transport: "sse", url });
    const canonicalDefault = applyOverride({ type: "sse" }, { url });
    expect(canonicalDefault).toEqual({ transport: "streamable-http", url });
    expect(applyOverride({ transport: "SSE" }, { url }).transport).toBe("sse");
    const unsupported = applyOverride({ transport: "custom", type: " CuStOm " }, { url });
    expect(unsupported.transport).toBe("custom");
    expect(
      resolveMcpTransportConfig("unsupported", unsupported, { logWarnings: false }),
    ).toBeNull();
  });
});
