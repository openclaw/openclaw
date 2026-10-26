// Fresh-process fixture: value imports stay outside OpenClaw until each scenario demands them.
import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { registerHooks } from "node:module";
import path from "node:path";
import { text } from "node:stream/consumers";
import type { FetchLike } from "@modelcontextprotocol/client";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OAuthCredential } from "./auth-profiles/types.js";

const PLUGIN_ID = "mcp-proof-owner";
const PROVIDER_ID = "mcp-proof-provider";
const EXTERNAL_PROFILE = `${PROVIDER_ID}:external`;
const STORED_PROFILE = `${PROVIDER_ID}:stored`;
const OBSERVER_CHANNEL = "openclaw.test.mcpAuthIntegrationObserver";
type HookContext = { config?: OpenClawConfig; agentDir?: string };
type ProviderEvent = { kind: string; owner: string };
type ProviderObservation = ProviderEvent & { context?: HookContext };
const providerEvents: ProviderEvent[] = [];
const observerErrors: unknown[] = [];
let inspectHook: ((owner: string, context?: HookContext) => void) | undefined;
let authRuntimeEntered = false;

// Shallow equality deliberately preserves callback, config, and registry identity.
function assertFields<T extends object>(actual: T | undefined, expected: Partial<T>) {
  assert(actual);
  for (const key in expected) {
    assert.equal(actual[key], expected[key], key);
  }
}

const credentialOwner = {
  type: "oauth" as const,
  provider: PROVIDER_ID,
  accountId: "fixture-account",
};
function credential(access: string, refresh: string, expires: number): OAuthCredential {
  return { ...credentialOwner, access, refresh, expires };
}

function observe(message: unknown): void {
  // The generated fixture publishes this exact payload through Node's synchronous channel.
  const { kind, owner, context } = message as ProviderObservation;
  providerEvents.push({ kind, owner });
  if (kind !== "evaluated" && kind !== "registered") {
    try {
      inspectHook?.(owner, context);
    } catch (error) {
      // Report scope failures after cleanup; subscriber throws become uncaught Node errors.
      observerErrors.push(error);
    }
  }
}

function writeProvider(root: string, owner: string, tokenUrl: string, enabled = true) {
  const pluginDir = path.join(root, "plugins", owner);
  const agentDir = path.join(root, "state", "agents", "main", "agent");
  const workspaceDir = path.join(root, "workspaces", owner);
  for (const dir of [pluginDir, agentDir, workspaceDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
  const credentialPath = path.join(root, `external-${owner}.txt`);
  fs.writeFileSync(credentialPath, "first");
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      providers: [PROVIDER_ID],
      contracts: { externalAuthProviders: [PROVIDER_ID] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const source = path.join(pluginDir, "index.cjs");
  fs.writeFileSync(
    source,
    `const fs = require("node:fs");
const observer = require("node:diagnostics_channel").channel(${JSON.stringify(OBSERVER_CHANNEL)});
const observe = (kind, context) => observer.publish({ kind, owner: ${JSON.stringify(owner)}, context });
observe("evaluated");
module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    observe("registered");
    api.registerProvider({
      id: ${JSON.stringify(PROVIDER_ID)},
      label: "MCP proof provider",
      auth: [],
      resolveExternalAuthProfiles(context) {
        observe("overlay", { config: context.config, agentDir: context.agentDir });
        const file = ${JSON.stringify(credentialPath)};
        if (!fs.existsSync(file)) return [];
        return [{ profileId: ${JSON.stringify(EXTERNAL_PROFILE)}, credential: {
          ...${JSON.stringify(credential("", "external-refresh-not-real", 1))},
          access: ${JSON.stringify(`${owner}:`)} + fs.readFileSync(file, "utf8"),
          expires: Date.now() + 3_600_000,
        }}];
      },
      formatApiKey(credential) {
        observe("formatted");
        return JSON.stringify({ token: credential.access, formatterOnly: "must-not-project" });
      },
      async refreshOAuth(credential) {
        observe("refresh");
        const response = await fetch(${JSON.stringify(tokenUrl)}, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh: credential.refresh }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("fixture refresh denied");
        }
        const rotated = await response.json();
        observe("refreshed");
        return { ...credential, ...rotated };
      },
    });
  },
};
`,
  );
  const config: OpenClawConfig = {
    plugins: {
      allow: [PLUGIN_ID],
      load: { paths: [source] },
      entries: { [PLUGIN_ID]: { enabled } },
      slots: { memory: "none" },
    },
  };
  return { config, agentDir, workspaceDir, credentialPath, source };
}

type ProviderFixture = ReturnType<typeof writeProvider>;
type HttpRequest = { method?: string; headers: IncomingHttpHeaders; body: string };
const configuredHeaders = { Authorization: "Bearer stale-config-not-real", "X-Trace": "keep" };
function authOptions(
  fixture: ProviderFixture,
  resourceUrl: string,
  authProfileId = EXTERNAL_PROFILE,
) {
  return {
    serverName: "proof",
    resourceUrl,
    authProfileId,
    cfg: fixture.config,
    agentDir: fixture.agentDir,
  };
}

async function createHttpFixture() {
  const { startCompletionServer } = await import("./simple-completion.test-support.js");
  const requests: HttpRequest[] = [];
  const refreshInputs: string[] = [];
  const order: string[] = [];
  const errors: unknown[] = [];
  const behavior = { rejectRefresh: false };
  const server = await startCompletionServer((request, response) => {
    void (async () => {
      const body = await text(request);
      response.setHeader("content-type", "application/json");
      const send = (code: number, value?: unknown) => {
        response.statusCode = code;
        response.end(value === undefined ? undefined : JSON.stringify(value));
      };
      if (request.url === "/token") {
        const input = JSON.parse(body) as { refresh: string };
        refreshInputs.push(input.refresh);
        order.push("refresh");
        return send(behavior.rejectRefresh ? 503 : 200, {
          access: "rotated-access-not-real",
          refresh: "rotated-refresh-not-real",
          expires: Date.now() + 3_600_000,
        });
      }
      requests.push({ method: request.method, headers: request.headers, body });
      order.push("mcp");
      const message: { id?: number; method?: string; params?: { protocolVersion: string } } = body
        ? JSON.parse(body)
        : {};
      // This JSON-only endpoint declines the SDK's optional SSE stream.
      if (request.method === "GET" && request.headers.accept === "text/event-stream") {
        response.setHeader("allow", "POST");
        return send(405);
      }
      if (message.method && message.id === undefined) {
        return send(202);
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: {},
              serverInfo: { name: "mcp-proof", version: "1.0.0" },
            }
          : {};
      send(
        200,
        message.id === undefined ? { ok: true } : { jsonrpc: "2.0", id: message.id, result },
      );
    })().catch((error: unknown) => {
      errors.push(error);
      response.statusCode = 500;
      response.end();
    });
  });
  return {
    url: `${server.origin}/mcp`,
    tokenUrl: `${server.origin}/token`,
    requests,
    refreshInputs,
    order,
    behavior,
    close: async () => {
      await server[Symbol.asyncDispose]();
      assert.deepEqual(errors, []);
    },
  };
}

async function consumeFetch(fetchFn: FetchLike, url: string | URL, init?: RequestInit) {
  const response = await fetchFn(url, init);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
}

function bundleConfig(url: string, profileId = STORED_PROFILE) {
  return {
    mcpServers: {
      proof: {
        url,
        auth: "oauth",
        oauth: { authProfileId: profileId },
        headers: configuredHeaders,
      },
    },
  };
}

function isCredentialModule(value: string): boolean {
  return /(?:^|\/)(?:auth-profiles\/(?:oauth|store)|mcp-auth-profile\.runtime)\.[cm]?[jt]s(?:$|[?#])/u.test(
    value.replaceAll("\\", "/"),
  );
}

async function runExternalScenario(root: string): Promise<void> {
  const endpoint = await createHttpFixture();
  const foreign = await createHttpFixture();
  const fixture = writeProvider(root, "external", endpoint.tokenUrl);
  const moduleAttempts: string[] = [];
  const observeModuleAttempt = (specifier: string) => {
    if (isCredentialModule(specifier)) {
      moduleAttempts.push(specifier);
      assert(
        authRuntimeEntered,
        `credential module requested before MCP bearer demand: ${specifier}`,
      );
    }
  };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      observeModuleAttempt(specifier);
      const resolved = nextResolve(specifier, context);
      if (!isCredentialModule(specifier)) {
        observeModuleAttempt(resolved.url);
      }
      return resolved;
    },
  });
  try {
    const { resolveMcpBearerBundleConfig: project, withMcpAuthProfileBearer } =
      await import("./mcp-auth-profile.js");
    const calls: Array<RequestInit | undefined> = [];
    const wrapped = withMcpAuthProfileBearer({
      fetchFn: async (url, init) => {
        calls.push(init);
        return fetch(url, init);
      },
      ...authOptions(fixture, endpoint.url),
      headers: configuredHeaders,
    });
    const plain = { mcpServers: { plain: { url: endpoint.url } } };
    assert.deepEqual(await project({ config: plain }), {
      config: plain,
      env: undefined,
    });
    const foreignInit = { headers: { Authorization: "Bearer caller-owned-not-real" } };
    await consumeFetch(wrapped, foreign.url, foreignInit);
    assert.equal(calls[0], foreignInit);
    assert.deepEqual([moduleAttempts, providerEvents], [[], []]);
    authRuntimeEntered = true;
    const signal = new AbortController().signal;
    await consumeFetch(wrapped, new URL(endpoint.url), {
      headers: { Authorization: "Bearer stale-request-not-real", Accept: "application/json" },
      signal,
    });
    assert.equal(calls.at(-1)?.signal, signal);
    assertFields(endpoint.requests.at(-1)?.headers, {
      authorization: "Bearer external:first",
      "x-trace": "keep",
      accept: "application/json",
    });
    assert(moduleAttempts.some((entry) => entry.includes("auth-profiles")));

    fs.writeFileSync(fixture.credentialPath, "rotated");
    await consumeFetch(wrapped, endpoint.url);
    assert.equal(endpoint.requests.at(-1)?.headers.authorization, "Bearer external:rotated");
    fs.rmSync(fixture.credentialPath);
    const sent = endpoint.requests.length;
    await assert.rejects(() => wrapped(endpoint.url), /profile was not found/u);
    assert.equal(endpoint.requests.length, sent);
    const eventsAfterRemoval = providerEvents.length;
    await consumeFetch(wrapped, new URL(foreign.url), foreignInit);
    assert.equal(calls.at(-1), foreignInit);
    assert.equal(providerEvents.length, eventsAfterRemoval);
    for (const request of foreign.requests) {
      assertFields(request.headers, {
        authorization: "Bearer caller-owned-not-real",
        "x-trace": undefined,
      });
    }
    const { loadPersistedAuthProfileStore } = await import("./auth-profiles/persisted.js");
    assert.equal(
      loadPersistedAuthProfileStore(fixture.agentDir)?.profiles[EXTERNAL_PROFILE],
      undefined,
    );
  } finally {
    hooks.deregister();
    await Promise.all([endpoint.close(), foreign.close()]);
  }
}

async function runRefreshScenario(root: string): Promise<void> {
  authRuntimeEntered = true;
  const { filterStringRecord } = await import("@openclaw/normalization-core/record-coerce");
  const { saveAuthProfileStore } = await import("./auth-profiles/store-runtime.js");
  const { loadPersistedAuthProfileStore } = await import("./auth-profiles/persisted.js");
  const { resolveMcpBearerBundleConfig, withMcpAuthProfileBearer } =
    await import("./mcp-auth-profile.js");
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const endpoint = await createHttpFixture();
  const fixture = writeProvider(root, "refresh", endpoint.tokenUrl);
  const expired = credential("expired-access-not-real", "stored-refresh-not-real", 1);
  const seed = () =>
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [STORED_PROFILE]: expired,
          [`${PROVIDER_ID}:static`]: {
            type: "token",
            provider: PROVIDER_ID,
            token: "static-not-real",
          },
        },
      },
      fixture.agentDir,
      {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      },
    );
  seed();
  const wrapped = withMcpAuthProfileBearer({
    fetchFn: fetch,
    ...authOptions(fixture, endpoint.url, STORED_PROFILE),
    headers: configuredHeaders,
  });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    fetch: wrapped,
    requestInit: { headers: { "X-Request": "keep", Authorization: "Bearer stale-sdk-not-real" } },
  });
  const client = new Client(
    { name: "mcp-auth-proof", version: "1.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  );
  const project = (profileId = STORED_PROFILE, tokenProjection?: "env" | "literal") =>
    resolveMcpBearerBundleConfig({
      config: bundleConfig(endpoint.url, profileId),
      cfg: fixture.config,
      agentDir: fixture.agentDir,
      tokenProjection,
    });
  // Optional SSE GETs are independent of the ordered RPC POSTs under test.
  const mcpPosts = () => endpoint.requests.filter((request) => request.method === "POST");
  try {
    await client.connect(transport);
    assert.deepEqual(await client.ping(), {});
    assert.deepEqual(await client.ping(), {});
    assert.deepEqual(endpoint.refreshInputs, ["stored-refresh-not-real"]);
    assert.equal(endpoint.order[0], "refresh");
    assert.deepEqual(
      mcpPosts().map((request) => (JSON.parse(request.body) as { method: string }).method),
      ["initialize", "notifications/initialized", "ping", "ping"],
    );
    for (const request of endpoint.requests) {
      assertFields(request.headers, {
        authorization: "Bearer rotated-access-not-real",
        "x-trace": "keep",
        "x-request": "keep",
        accept:
          request.method === "POST" ? "application/json, text/event-stream" : "text/event-stream",
      });
    }
    const stored = loadPersistedAuthProfileStore(fixture.agentDir)?.profiles[STORED_PROFILE];
    assert(stored?.type === "oauth");
    assertFields(stored, {
      access: "rotated-access-not-real",
      refresh: "rotated-refresh-not-real",
      accountId: "fixture-account",
    });

    for (const tokenProjection of ["env", "literal"] as const) {
      const projected = await project(STORED_PROFILE, tokenProjection);
      const server = projected.config.mcpServers.proof;
      assert(server);
      const headers = filterStringRecord(server.headers);
      const authorization = headers?.Authorization;
      assert.equal(typeof authorization, "string");
      if (tokenProjection === "literal") {
        assert.equal(authorization, "Bearer rotated-access-not-real");
        assert.equal(projected.env, undefined);
      } else {
        const envKey = /^Bearer \$\{([^}]+)\}$/u.exec(String(authorization))?.[1];
        assert(envKey);
        assert.equal(projected.env?.[envKey], "rotated-access-not-real");
      }
      assert.equal(headers?.["X-Trace"], "keep");
      assertFields(server, { auth: undefined, oauth: undefined });
      assert.doesNotMatch(JSON.stringify(projected), /rotated-refresh-not-real|formatterOnly/u);
    }
    for (const [profileId, error] of [
      [`${PROVIDER_ID}:missing`, /profile was not found/u],
      [`${PROVIDER_ID}:static`, /profiles are not refreshable/u],
    ] as const) {
      await assert.rejects(() => project(profileId), error);
    }
    seed();
    endpoint.behavior.rejectRefresh = true;
    const sent = mcpPosts().length;
    await assert.rejects(
      () => client.ping(),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /fixture refresh denied/u);
        assert.doesNotMatch(error.message, /expired-access-not-real|stored-refresh-not-real/u);
        return true;
      },
    );
    assert.equal(mcpPosts().length, sent);
  } finally {
    await client.close();
    await endpoint.close();
  }
}

async function runScopeScenario(root: string): Promise<void> {
  authRuntimeEntered = true;
  const { createPluginCache, withPluginCache } = await import("../plugins/plugin-cache.js");
  const { loadPluginMetadataSnapshot } = await import("../plugins/plugin-metadata-snapshot.js");
  const { loadPluginRegistryHandle } = await import("../plugins/loader.js");
  const { createEmptyPluginRegistry } = await import("../plugins/registry-empty.js");
  const { getPluginRegistryState } = await import("../plugins/runtime-state.js");
  const { setActivePluginRegistry } = await import("../plugins/runtime.js");
  const generationScope = await import("../plugins/runtime/generation-scope.js");
  const requestScope = await import("../plugins/runtime/gateway-request-scope.js");
  const { withMcpAuthProfileBearer } = await import("./mcp-auth-profile.js");
  const prepare = (fixture: ProviderFixture) =>
    withPluginCache(createPluginCache(), () => {
      const options = {
        config: fixture.config,
        env: process.env,
        workspaceDir: fixture.workspaceDir,
      };
      const metadataSnapshot = loadPluginMetadataSnapshot({ ...options, preferPersisted: false });
      const pluginRegistry = loadPluginRegistryHandle({
        ...options,
        manifestRegistry: metadataSnapshot.manifestRegistry,
        installRecords: {},
        onlyPluginIds: [PLUGIN_ID],
        cache: false,
      });
      return { config: fixture.config, metadataSnapshot, pluginRegistry };
    });
  const endpoint = await createHttpFixture();
  try {
    const owners = ["first", "second", "disabled"].map((name, index) => {
      const fixture = writeProvider(root, name, endpoint.tokenUrl, name !== "disabled");
      return {
        fixture,
        generation: prepare(fixture),
        request: {
          pluginId: `requester-${index}`,
          isWebchatConnect: () => false,
          resolveGatewayContext: () => undefined,
        },
      };
    });
    type ScopedOwner = (typeof owners)[number];
    const [first, second, disabled] = owners;
    assert(first && second && disabled);
    assert.deepEqual(
      owners.map(({ generation }) => generation.pluginRegistry.providers.length),
      [1, 1, 0],
    );
    const checkScope = (
      { request, fixture, generation }: ScopedOwner,
      context?: HookContext,
      pluginOwner = false,
    ) => {
      const scope = requestScope.getPluginRuntimeGatewayRequestScope();
      assert(scope, "request scope must survive deferred auth");
      assertFields(scope, {
        ...request,
        ...(pluginOwner
          ? {
              pluginId: PLUGIN_ID,
              pluginSource: fixture.source,
              pluginOrigin: "config" as const,
            }
          : {}),
        pluginRegistry: generation.pluginRegistry,
        declaredProviderOwners: generation.metadataSnapshot.declaredProviderOwners,
      });
      assert.equal(generationScope.getPluginRuntimeGenerationRegistry(), generation.pluginRegistry);
      if (context) {
        assertFields(context, { config: fixture.config, agentDir: fixture.agentDir });
      }
    };
    inspectHook = (name, context) => checkScope(name === "first" ? first : second, context, true);
    const bind = (owner: ScopedOwner) => {
      const wrapped = withMcpAuthProfileBearer({
        fetchFn: async (url, init) => {
          checkScope(owner);
          return fetch(url, init);
        },
        ...authOptions(owner.fixture, endpoint.url),
      });
      return () =>
        requestScope.withPluginRuntimeGatewayRequestScope(owner.request, () =>
          generationScope.withPluginRuntimeGenerationScope(owner.generation, () =>
            consumeFetch(wrapped, endpoint.url),
          ),
        );
    };
    const firstRequest = bind(first);
    const secondRequest = bind(second);
    setActivePluginRegistry(createEmptyPluginRegistry(), "empty-root");
    const pendingFirst = firstRequest();
    setActivePluginRegistry(
      second.generation.pluginRegistry,
      "replacement-root",
      "default",
      second.fixture.workspaceDir,
    );
    await Promise.all([pendingFirst, secondRequest()]);
    const authorizations = endpoint.requests.map((request) => {
      const authorization = request.headers.authorization;
      assert(authorization, "missing Authorization header on a scoped MCP request");
      return authorization;
    });
    assert.deepEqual(
      authorizations.toSorted((left, right) => left.localeCompare(right)),
      ["Bearer first:first", "Bearer second:first"],
    );
    fs.writeFileSync(first.fixture.credentialPath, "rotated");
    await firstRequest();
    assert.equal(endpoint.requests.at(-1)?.headers.authorization, "Bearer first:rotated");
    const sent = endpoint.requests.length;
    await assert.rejects(bind(disabled), /profile was not found/u);
    assert.equal(endpoint.requests.length, sent);
    assert(!providerEvents.some((event) => event.owner === "disabled"));
    assert.equal(requestScope.getPluginRuntimeGatewayRequestScope(), undefined);
    assert.equal(generationScope.getPluginRuntimeGenerationRegistry(), undefined);
    assert.equal(getPluginRegistryState()?.activeRegistry, second.generation.pluginRegistry);
  } finally {
    inspectHook = undefined;
    await endpoint.close();
  }
}

async function main(): Promise<void> {
  const [scenario, root] = process.argv.slice(2);
  assert(root && scenario);
  const observer = channel(OBSERVER_CHANNEL);
  observer.subscribe(observe);
  try {
    const run = new Map([
      ["external", runExternalScenario],
      ["refresh", runRefreshScenario],
      ["scopes", runScopeScenario],
    ]).get(scenario);
    assert(run, `Unknown MCP auth proof scenario: ${scenario}`);
    await run(root);
  } finally {
    try {
      // A rejected cold import must not load auth owners merely to clean them up.
      if (authRuntimeEntered) {
        const { closeAuthProfileReadPool } = await import("./auth-profiles/sqlite.js");
        const { closeOpenClawAgentDatabasesForTest } =
          await import("../state/openclaw-agent-db.js");
        const { closeOpenClawStateDatabaseForTest } = await import("../state/openclaw-state-db.js");
        closeAuthProfileReadPool();
        // Agent closure releases leases through shared state; close that owner last.
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    } finally {
      observer.unsubscribe(observe);
    }
  }
  assert.deepEqual(observerErrors, [], "provider hooks must retain their exact request scope");
  console.log(`MCP_AUTH_PROOF_OK ${scenario}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
