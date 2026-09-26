import { createServer, type Server } from "node:http";
import type { ILogger } from "@microsoft/teams.common";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createEmptyPluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { acquireTestPortBlock, useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, expect, it, vi } from "vitest";
import { getMSTeamsIngressMockState } from "./monitor-ingress-mock.test-support.js";
import {
  createConfig,
  createRuntime,
  createStores,
  updateMSTeamsConfig,
} from "./monitor-lifecycle.test-helpers.js";
import { createSigninEvent } from "./monitor-sso.test-helpers.js";
import { monitorMSTeamsProvider } from "./monitor.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { createMSTeamsSsoTokenStoreFs } from "./sso-token-store.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

const fixture = vi.hoisted(() => ({ origin: "", botToken: "" }));

// Substitute identity infrastructure, preserving the real loader, Express adapter on a Gateway route,
// signature validation, process dispatch, sender policy, and SQLite token store.
vi.mock("@microsoft/teams.apps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@microsoft/teams.apps")>();
  const { PUBLIC, withOverrides } = await import("@microsoft/teams.api");
  const logger: ILogger = {
    child: () => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    log: () => {},
    trace: () => {},
  };
  return {
    ...actual,
    App: class extends actual.App {
      constructor(options: ConstructorParameters<typeof actual.App>[0]) {
        super({
          ...options,
          clientSecret: "",
          token: async () => fixture.botToken,
          dangerouslyAllowUnauthenticatedRequests: false,
          logger,
          cloud: withOverrides(PUBLIC, {
            openIdMetadataUrl: `${fixture.origin}/openidconfiguration`,
            tokenServiceUrl: fixture.origin,
          }),
          apiClientSettings: { oauthUrl: fixture.origin },
          client: {
            interceptors: [
              {
                request: ({ config }) => {
                  if (new URL(config.url!).origin !== fixture.origin) {
                    throw new Error("SSO ingress fixture rejected external HTTP request");
                  }
                  config.proxy = false;
                  return config;
                },
              },
            ],
          },
        });
      }
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  }),
);

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

it("authenticates SSO webhooks before real sender authorization, token I/O, and persistence", async () => {
  const stateDir = tempDirs.make("openclaw-msteams-sso-ingress-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const allowedId = "11111111-1111-4111-8111-111111111111";
  const deniedId = "22222222-2222-4222-8222-222222222222";
  const serviceUrl = "https://smba.trafficmanager.net/teams";
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
  const kid = "synthetic-sso-signing-key";
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" }] };
  const mintToken = (audience: string) =>
    new SignJWT({
      aud: audience,
      iss: "https://api.botframework.com",
      serviceurl: serviceUrl,
    })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  const signedToken = await mintToken("app-id");
  const wrongAudienceToken = await mintToken("another-app");
  const signatureOffset = signedToken.lastIndexOf(".") + 1;
  const signature = Buffer.from(signedToken.slice(signatureOffset), "base64url");
  signature.writeUInt8(signature.readUInt8(0) ^ 1, 0);
  const invalidSignatureToken =
    signedToken.slice(0, signatureOffset) + signature.toString("base64url");
  fixture.botToken = signedToken;
  const tokenRequests: Array<{
    method?: string;
    path: string;
    query: Record<string, string>;
    body: unknown;
  }> = [];
  let keyRequests = 0;
  const infra = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", fixture.origin);
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/keys") {
        keyRequests++;
        res.end(JSON.stringify(jwks));
        return;
      }
      if (
        url.pathname !== "/api/usertoken/GetToken" &&
        url.pathname !== "/api/usertoken/exchange"
      ) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString("utf8");
      tokenRequests.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: text ? JSON.parse(text) : undefined,
      });
      if (req.headers.authorization !== `Bearer ${fixture.botToken}`) {
        res.writeHead(401).end(JSON.stringify({ error: "Missing bot credential" }));
        return;
      }
      res.end(
        JSON.stringify(
          url.pathname.endsWith("/exchange") || url.searchParams.has("code")
            ? {
                channelId: "msteams",
                connectionName: "graph",
                token: "synthetic-delegated-token",
                expiration: "2030-01-01T00:00:00Z",
              }
            : {},
        ),
      );
    })().catch(() => res.writeHead(500).end());
  });
  const claim = await acquireTestPortBlock({ offsets: [0, 1] });
  fixture.origin = `http://127.0.0.1:${claim.port}`;
  const registry = createEmptyPluginRegistry();
  const gateway = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = registry.httpRoutes.find((entry) => entry.path === path);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    Promise.resolve(route.handler(req, res)).catch(() => res.writeHead(500).end());
  });
  const abort = new AbortController();
  let monitorTask: ReturnType<typeof monitorMSTeamsProvider> | undefined;
  let persisted = createDeferred<void>();
  const runtime = createPluginRuntimeMock({
    state: msteamsRuntimeStub.state,
    logging: {
      getChildLogger: () => ({
        info: (message: string) => {
          if (message === "msteams sso token persisted") {
            persisted.resolve();
          }
        },
        error: (message: string, details?: Record<string, unknown>) => {
          const error = typeof details?.error === "string" ? details.error : "unknown error";
          persisted.reject(new Error(`${message}: ${error}`));
        },
        warn: () => {},
        debug: () => {},
      }),
    },
  });
  // createPluginRuntimeMock retains the production stable ingress policy resolver.
  const policy = vi.spyOn(runtime.channel.inbound.ingress, "resolveStable");
  setMSTeamsRuntime(runtime);
  const store = createMSTeamsSsoTokenStoreFs({ stateDir });
  const cfg = createConfig();
  updateMSTeamsConfig(cfg, {
    dmPolicy: "allowlist",
    allowFrom: [allowedId],
    sso: { enabled: true, connectionName: "graph" },
  });
  const ready = createDeferred<void>();
  try {
    await new Promise<void>((resolve, reject) => {
      infra.once("error", reject);
      infra.listen(claim.port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) => {
      gateway.once("error", reject);
      gateway.listen(claim.port + 1, "127.0.0.1", resolve);
    });
    setActivePluginRegistry(registry);
    monitorTask = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      ...createStores(),
      statusSink: (patch) => {
        if (patch.connected) {
          ready.resolve();
        }
      },
    });
    await Promise.race([
      ready.promise,
      monitorTask.then(() => {
        throw new Error("Monitor stopped before ready");
      }),
    ]);
    const post = async (body: ReturnType<typeof createSigninEvent>["body"], token: string) => {
      const response = await fetch(`http://127.0.0.1:${claim.port + 1}/api/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await response.text();
      return response.status;
    };
    for (const name of ["signin/tokenExchange", "signin/verifyState"] as const) {
      const body = createSigninEvent(name).body;
      body.from = { id: `29:${name}`, aadObjectId: allowedId };
      persisted = createDeferred<void>();
      policy.mockClear();
      tokenRequests.length = 0;
      expect(await post(body, signedToken), `${name}: allowed`).toBe(200);
      await persisted.promise;
      expect(policy).toHaveBeenCalledTimes(2);
      expect(tokenRequests).toEqual([
        {
          method: "GET",
          path: "/api/usertoken/GetToken",
          query: { channelId: "msteams", userId: body.from.id, connectionName: "graph" },
          body: undefined,
        },
        name === "signin/tokenExchange"
          ? {
              method: "POST",
              path: "/api/usertoken/exchange",
              query: { channelId: "msteams", userId: body.from.id, connectionName: "graph" },
              body: { token: "fixture-user-token" },
            }
          : {
              method: "GET",
              path: "/api/usertoken/GetToken",
              query: {
                channelId: "msteams",
                userId: body.from.id,
                connectionName: "graph",
                code: "fixture-state",
              },
              body: undefined,
            },
      ]);
      for (const userId of [body.from.id, allowedId]) {
        expect(await store.get({ connectionName: "graph", userId })).toMatchObject({
          userId,
          connectionName: "graph",
          token: "synthetic-delegated-token",
          expiresAt: "2030-01-01T00:00:00Z",
        });
        await store.remove({ connectionName: "graph", userId });
      }

      body.from = { id: `29:denied-${name}`, aadObjectId: deniedId };
      policy.mockClear();
      tokenRequests.length = 0;
      expect(await post(body, signedToken), `${name}: denied`).toBe(200);
      expect(tokenRequests).toEqual([]);
      expect(policy).toHaveBeenCalledTimes(1);
      for (const userId of [body.from.id, deniedId]) {
        expect(await store.get({ connectionName: "graph", userId })).toBeNull();
      }

      body.from = { id: `29:unauthenticated-${name}`, aadObjectId: allowedId };
      for (const token of [wrongAudienceToken, invalidSignatureToken]) {
        policy.mockClear();
        expect(await post(body, token), `${name}: invalid authentication`).toBe(401);
        expect(policy).not.toHaveBeenCalled();
        expect(tokenRequests).toEqual([]);
        for (const userId of [body.from.id, allowedId]) {
          expect(await store.get({ connectionName: "graph", userId })).toBeNull();
        }
      }
    }
    expect(keyRequests).toBeGreaterThan(0);
    expect(getMSTeamsIngressMockState().instances.at(-1)?.accept).not.toHaveBeenCalled();
  } finally {
    abort.abort();
    try {
      await monitorTask;
      expect(registry.httpRoutes).toHaveLength(0);
    } finally {
      try {
        await Promise.all([infra, gateway].filter((server) => server.listening).map(closeServer));
      } finally {
        await claim.release();
        policy.mockRestore();
        resetPluginRuntimeStateForTest();
        vi.unstubAllEnvs();
      }
    }
  }
});
