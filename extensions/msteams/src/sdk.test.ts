// Msteams tests cover sdk plugin behavior.
import type { ClientOptions, RequestContext } from "@microsoft/teams.common";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startMSTeamsQaBotFrameworkServer } from "./qa/bot-framework-server.js";
import { sendMSTeamsActivityWithReference } from "./sdk-proactive.js";
import { createMSTeamsTokenProvider, loadMSTeamsSdkWithAuth } from "./sdk.js";
import type { MSTeamsCredentials, MSTeamsFederatedCredentials } from "./token.js";

const secretCredentials: MSTeamsCredentials = {
  type: "secret",
  appId: "test-app-id",
  appPassword: "test-secret",
  tenantId: "test-tenant",
};

const privateQaRuntimeSymbol = Symbol.for("openclaw.msteams.privateQaRuntime");
const privateQaBotToken = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ appid: "test-app-id", tid: "test-tenant" })).toString("base64url"),
  "qa",
].join(".");

const { readSecretFile } = vi.hoisted(() => ({
  readSecretFile: vi
    .fn<(filePath: string, label: string) => Promise<string>>()
    .mockResolvedValue("-----BEGIN RSA PRIVATE KEY-----\nfake-key\n-----END RSA PRIVATE KEY-----"),
}));

vi.mock("openclaw/plugin-sdk/secret-file", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/secret-file")>();
  return {
    ...actual,
    readSecretFile,
  };
});

const { mockGetToken } = vi.hoisted(() => {
  const mockGetTokenLocal = vi.fn().mockResolvedValue({ token: "mock-managed-token" });
  return { mockGetToken: mockGetTokenLocal };
});
vi.mock("@azure/identity", () => {
  class ManagedIdentityCredential {
    getToken = mockGetToken;
  }
  class DefaultAzureCredential {
    getToken = mockGetToken;
  }
  class ClientCertificateCredential {
    getToken = mockGetToken;
  }
  return { ManagedIdentityCredential, DefaultAzureCredential, ClientCertificateCredential };
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (
    globalThis as typeof globalThis & {
      [privateQaRuntimeSymbol]?: unknown;
    }
  )[privateQaRuntimeSymbol];
  vi.restoreAllMocks();
  readSecretFile
    .mockReset()
    .mockResolvedValue("-----BEGIN RSA PRIVATE KEY-----\nfake-key\n-----END RSA PRIVATE KEY-----");
});

async function createMSTeamsApp(...args: Parameters<typeof loadMSTeamsSdkWithAuth>) {
  return (await loadMSTeamsSdkWithAuth(...args)).app;
}

describe("createMSTeamsApp", () => {
  it("does not crash with express 5 path-to-regexp (#55161)", async () => {
    const app = await createMSTeamsApp(secretCredentials);
    expect(app).toBeDefined();
    expect(app.tokenProvider).toBeDefined();
  });

  it("keeps private QA App options absent in production", async () => {
    const app = await createMSTeamsApp(secretCredentials);
    const options = (app as unknown as { options?: Record<string, unknown> }).options;
    expect(options?.skipAuth).toBeUndefined();
    expect(options?.token).toBeUndefined();
  });

  it("passes the complete private QA bootstrap into the SDK App", async () => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    vi.stubEnv("CLIENT_SECRET", "ambient-private-qa-secret");
    (
      globalThis as typeof globalThis & {
        [privateQaRuntimeSymbol]?: {
          connectorUrl: string;
          nonce: string;
          botToken: string;
        };
      }
    )[privateQaRuntimeSymbol] = {
      connectorUrl: "http://127.0.0.1:43123/",
      nonce: "qa-nonce",
      botToken: privateQaBotToken,
    };

    const app = await createMSTeamsApp(secretCredentials);
    const options = (app as unknown as { options?: Record<string, unknown> }).options;
    expect(options?.skipAuth).toBe(true);
    expect(options?.clientSecret).toBe("");
    expect(options?.client).toEqual(expect.objectContaining({ interceptors: expect.any(Array) }));
    expect(options?.token).toEqual(expect.any(Function));
    const token = options?.token;
    if (typeof token !== "function") {
      throw new Error("expected private QA token factory");
    }
    await expect(token()).resolves.toBe(privateQaBotToken);
    const credentials = (
      app as unknown as {
        credentials?: Record<string, unknown>;
      }
    ).credentials;
    expect(credentials).toMatchObject({
      clientId: "test-app-id",
      token: expect.any(Function),
    });
    expect(credentials).not.toHaveProperty("clientSecret");
    expect(
      String(await app.tokenProvider.getAppToken("https://api.botframework.com/.default")),
    ).toBe(privateQaBotToken);
  });

  it.each([
    {
      name: "routes a private QA proactive send through the loopback Connector",
      revokeAt: "never",
    },
    {
      name: "does not dispatch a private QA send when authority closes during token acquisition",
      revokeAt: "token",
    },
    {
      name: "retains a private QA accepted receipt when authority closes before the response",
      revokeAt: "accepted",
    },
  ] as const)("$name", async ({ revokeAt }) => {
    vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "1");
    vi.stubEnv("CLIENT_SECRET", "ambient-private-qa-secret");
    const tokenStarted = createDeferred<void>();
    const releaseToken = createDeferred<void>();
    const onPlatformSendDispatch = vi.fn(async () => {});
    let active = true;
    let pendingSend: Promise<unknown> | undefined;
    const outbound: Array<{
      activity: Record<string, unknown>;
      activityId: string;
      conversationId: string;
      threadId?: string;
    }> = [];
    const connector = await startMSTeamsQaBotFrameworkServer({
      botToken: privateQaBotToken,
      nonce: "qa-nonce",
      onOutbound: async (activity) => {
        outbound.push(activity);
        if (revokeAt === "accepted") {
          active = false;
        }
      },
    });
    (
      globalThis as typeof globalThis & {
        [privateQaRuntimeSymbol]?: {
          connectorUrl: string;
          nonce: string;
          botToken: string;
        };
      }
    )[privateQaRuntimeSymbol] = {
      connectorUrl: connector.baseUrl,
      nonce: "qa-nonce",
      botToken: privateQaBotToken,
    };

    try {
      const app = await createMSTeamsApp(secretCredentials);
      const getAppToken = app.tokenProvider.getAppToken.bind(app.tokenProvider);
      vi.spyOn(app.tokenProvider, "getAppToken").mockImplementation(async (...args) => {
        tokenStarted.resolve();
        await releaseToken.promise;
        return getAppToken(...args);
      });
      const send = sendMSTeamsActivityWithReference(
        app,
        {
          serviceUrl: "https://smba.trafficmanager.net/qa",
          agent: { id: "test-app-id", name: "OpenClaw QA", role: "bot" },
          user: { id: "qa-driver" },
          conversation: {
            id: "19:qa-primary@thread.tacv2",
            conversationType: "channel",
            tenantId: "test-tenant",
          },
          channelId: "msteams",
        },
        { type: "message", text: "qa outbound" },
        {
          threadActivityId: "thread-root",
          assertDirectAdapterHandoff: () => {
            if (!active) {
              throw new Error("private QA delivery authority closed");
            }
          },
          onPlatformSendDispatch,
        },
      );
      pendingSend = send.catch(() => undefined);

      await Promise.race([tokenStarted.promise, send]);
      expect(outbound).toEqual([]);
      expect(onPlatformSendDispatch).not.toHaveBeenCalled();
      if (revokeAt === "token") {
        active = false;
      }
      releaseToken.resolve();

      if (revokeAt === "token") {
        await expect(send).rejects.toThrow("private QA delivery authority closed");
        expect(outbound).toEqual([]);
        expect(onPlatformSendDispatch).not.toHaveBeenCalled();
        return;
      }

      const result = await send;

      expect(result.id).toMatch(/^qa-outbound-/u);
      expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
      expect(active).toBe(revokeAt === "never");
      expect(outbound).toEqual([
        {
          activity: expect.objectContaining({
            type: "message",
            text: "qa outbound",
          }),
          activityId: result.id,
          conversationId: "19:qa-primary@thread.tacv2",
          threadId: "thread-root",
        },
      ]);
    } finally {
      releaseToken.resolve();
      await pendingSend;
      await connector.close();
    }
  });

  it("creates app with federated certificate credentials", async () => {
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "test-app-id",
      tenantId: "test-tenant",
      certificatePath: "/path/to/cert.pem",
    };

    const app = await createMSTeamsApp(creds);
    expect(app).toBeDefined();
    expect(readSecretFile).toHaveBeenCalledWith("/path/to/cert.pem", "Microsoft Teams certificate");
  });

  it.each([
    {
      label: "certificate",
      credentials: {
        type: "federated" as const,
        appId: "test-app-id",
        tenantId: "test-tenant",
        certificatePath: "/path/to/cert.pem",
      },
      expected: { clientId: "test-app-id", token: expect.any(Function) },
    },
    {
      label: "managed identity",
      credentials: {
        type: "federated" as const,
        appId: "test-app-id",
        tenantId: "test-tenant",
        useManagedIdentity: true,
      },
      expected: {
        clientId: "test-app-id",
        managedIdentityClientId: "system",
        managedIdentityType: "system",
      },
    },
  ])("prevents ambient CLIENT_SECRET from overriding $label authentication", async (mode) => {
    vi.stubEnv("CLIENT_SECRET", "ambient-secret-must-not-win");

    const app = await createMSTeamsApp(mode.credentials);
    const credentials = (app as unknown as { credentials?: Record<string, unknown> }).credentials;

    expect(credentials).toMatchObject(mode.expected);
    expect(credentials).not.toHaveProperty("clientSecret");
  });

  it("throws when certificate file is missing", async () => {
    const certificatePath = "/private/msteams-race-sensitive-certificate.pem";
    readSecretFile.mockRejectedValue(new Error(`ENOENT: no such file, open '${certificatePath}'`));

    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "test-app-id",
      tenantId: "test-tenant",
      certificatePath,
    };

    const error = await createMSTeamsApp(creds).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toContain("Failed to read certificate file");
      expect(error.message).not.toContain(certificatePath);
    }
  });

  it("creates app with user-assigned managed identity", async () => {
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "test-app-id",
      tenantId: "test-tenant",
      useManagedIdentity: true,
      managedIdentityClientId: "custom-mi-id",
    };

    const app = await createMSTeamsApp(creds);
    expect(app).toBeDefined();
  });

  it("throws when federated credentials lack certificate and managed identity", async () => {
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "test-app-id",
      tenantId: "test-tenant",
    };

    await expect(createMSTeamsApp(creds)).rejects.toThrow(
      "Federated credentials require either a certificate path or managed identity",
    );
  });

  it("preserves both Teams SDK and OpenClaw User-Agent fragments", async () => {
    const app = await createMSTeamsApp(secretCredentials);
    const headers = (
      app as unknown as { client?: { options?: { headers?: Record<string, string> } } }
    ).client?.options?.headers;

    expect(headers?.["User-Agent"]).toMatch(/^teams\.ts\[apps\]\/\S+ OpenClaw\/\S+$/);
  });

  it("bounds Teams SDK API requests", async () => {
    const app = await createMSTeamsApp(secretCredentials);
    const timeout = (app as unknown as { client?: { options?: { timeout?: number } } }).client
      ?.options?.timeout;

    expect(timeout).toBe(30_000);
  });

  it("accepts custom messagingEndpoint", async () => {
    const app = await createMSTeamsApp(secretCredentials, {
      messagingEndpoint: "/custom/webhook",
    });
    expect(app).toBeDefined();
  });

  it("passes configured cloud and serviceUrl to the SDK App", async () => {
    const app = await createMSTeamsApp(secretCredentials, {
      cloud: "USGov",
      serviceUrl: "https://smba.infra.gov.teams.microsoft.us/teams/",
    });

    const internals = app as unknown as {
      api?: { serviceUrl?: string };
      cloud?: { botScope?: string; graphScope?: string };
    };
    expect(internals.api?.serviceUrl).toBe("https://smba.infra.gov.teams.microsoft.us/teams");
    expect(internals.cloud?.botScope).toBe("https://api.botframework.us/.default");
    expect(internals.cloud?.graphScope).toBe("https://graph.microsoft.us/.default");
  });

  it("passes China cloud to the SDK App without requiring a configured serviceUrl", async () => {
    const app = await createMSTeamsApp(secretCredentials, {
      cloud: "China",
    });

    const internals = app as unknown as {
      api?: { serviceUrl?: string };
      cloud?: { botScope?: string; graphScope?: string };
    };
    // @microsoft/teams.apps still gives app-level sends its public serviceUrl
    // default. OpenClaw proactive sends use stored reference serviceUrls instead.
    expect(internals.api?.serviceUrl).toBe("https://smba.trafficmanager.net/teams");
    expect(internals.cloud?.botScope).toBe("https://api.botframework.azure.cn/.default");
    expect(internals.cloud?.graphScope).toBe("https://microsoftgraph.chinacloudapi.cn/.default");
  });

  it("fails closed for Graph tokens when China cloud is configured", async () => {
    const app = await createMSTeamsApp(secretCredentials, { cloud: "China" });
    const tokenProvider = createMSTeamsTokenProvider(app);

    await expect(tokenProvider.getAccessToken("https://graph.microsoft.com")).rejects.toThrow(
      /Graph operations are not supported .*cloud=China/,
    );
  });

  it("rejects configured serviceUrls outside the Bot Framework allowlist", async () => {
    await expect(
      createMSTeamsApp(secretCredentials, {
        serviceUrl: "https://attacker.example.com/teams/",
      }),
    ).rejects.toThrow(/Blocked Microsoft Teams serviceUrl host: attacker\.example\.com/);
  });

  it("uses the configured cloud serviceUrl for proactive HTTP posts", async () => {
    const dispatch = vi.fn(async (config: RequestContext["config"]) => ({
      data: { id: "sent-1" },
      status: 201,
      statusText: "Created",
      headers: {},
      config,
    }));
    const httpClient = {
      interceptors: [
        {
          request: ({ config }) => {
            config.adapter = dispatch;
            return config;
          },
        },
      ],
    } satisfies ClientOptions;

    const app = await createMSTeamsApp(secretCredentials, {
      cloud: "USGov",
      serviceUrl: "https://smba.infra.gov.teams.microsoft.us/teams",
      httpClient,
    });
    vi.spyOn(app.tokenProvider, "getAppToken").mockResolvedValue(null);

    await app.send("19:conversation@thread.tacv2", { type: "message", text: "hello" });

    expect(dispatch).toHaveBeenCalledOnce();
    const [request] = dispatch.mock.calls[0]!;
    expect(request.method).toBe("post");
    expect(request.url).toBe(
      "https://smba.infra.gov.teams.microsoft.us/teams/v3/conversations/19:conversation@thread.tacv2/activities",
    );
    expect(JSON.parse(request.data)).toMatchObject({
      type: "message",
      text: "hello",
      conversation: { id: "19:conversation@thread.tacv2" },
    });
  });
});

describe("createMSTeamsTokenProvider", () => {
  function createMockApp() {
    return {
      tokenProvider: {
        getAppToken: vi.fn(async () => ({ toString: (): string => "access-token" })),
      },
    };
  }

  it.each([
    undefined,
    "https://api.botframework.us/.default",
    "https://api.botframework.azure.cn/.default",
  ])("returns bot tokens using the configured cloud scope %s", async (botScope) => {
    const app = { ...createMockApp(), cloud: { botScope } };
    const provider = createMSTeamsTokenProvider(app);

    const token = await provider.getAccessToken("https://api.botframework.com");
    expect(token).toBe("access-token");
    expect(app.tokenProvider.getAppToken).toHaveBeenCalledWith(
      botScope ?? "https://api.botframework.com/.default",
    );
  });

  it.each([
    { graphScope: undefined, tenantId: undefined },
    { graphScope: undefined, tenantId: "configured-tenant" },
    { graphScope: "https://graph.microsoft.us/.default", tenantId: "sovereign-tenant" },
  ])(
    "returns Graph tokens using cloud and tenant $graphScope $tenantId",
    async ({ graphScope, tenantId }) => {
      const app = { ...createMockApp(), cloud: { graphScope }, credentials: { tenantId } };
      const provider = createMSTeamsTokenProvider(app);

      const token = await provider.getAccessToken("https://graph.microsoft.com");
      expect(token).toBe("access-token");
      expect(app.tokenProvider.getAppToken).toHaveBeenCalledWith(
        graphScope ?? "https://graph.microsoft.com/.default",
        tenantId ?? "common",
      );
    },
  );

  it("returns empty string when token is null", async () => {
    const app = {
      tokenProvider: {
        getAppToken: async () => null,
      },
    };
    const provider = createMSTeamsTokenProvider(app);

    expect(await provider.getAccessToken("https://api.botframework.com")).toBe("");
    expect(await provider.getAccessToken("https://graph.microsoft.com")).toBe("");
  });
});
