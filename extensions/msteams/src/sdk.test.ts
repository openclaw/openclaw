import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMSTeamsApp, createMSTeamsTokenProvider } from "./sdk.js";
import type { MSTeamsCredentials, MSTeamsFederatedCredentials } from "./token.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(
      () => "-----BEGIN RSA PRIVATE KEY-----\nfake-key\n-----END RSA PRIVATE KEY-----",
    ),
  };
});

const { mockGetToken } = vi.hoisted(() => {
  const mockGetToken = vi.fn().mockResolvedValue({ token: "mock-managed-token" });
  return { mockGetToken };
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
  vi.restoreAllMocks();
});

describe("createMSTeamsApp", () => {
  it("does not crash with express 5 path-to-regexp (#55161)", async () => {
    const creds: MSTeamsCredentials = {
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    const app = await createMSTeamsApp(creds);
    expect(app).toBeDefined();
    expect(app.tokenManager).toBeDefined();
  });

  it("creates app with secret credentials", async () => {
    const creds: MSTeamsCredentials = {
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    const app = await createMSTeamsApp(creds);
    expect(app).toBeDefined();
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
    expect(fs.readFileSync).toHaveBeenCalledWith("/path/to/cert.pem", "utf-8");
  });

  it("throws when certificate file is missing", async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });

    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "test-app-id",
      tenantId: "test-tenant",
      certificatePath: "/bad/path.pem",
    };

    await expect(createMSTeamsApp(creds)).rejects.toThrow("Failed to read certificate file");
  });

  it("creates app with managed identity credentials", async () => {
    const creds: MSTeamsFederatedCredentials = {
      type: "federated",
      appId: "test-app-id",
      tenantId: "test-tenant",
      useManagedIdentity: true,
    };

    const app = await createMSTeamsApp(creds);
    expect(app).toBeDefined();
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

  it("accepts custom messagingEndpoint", async () => {
    const creds: MSTeamsCredentials = {
      type: "secret",
      appId: "test-app-id",
      appPassword: "test-secret",
      tenantId: "test-tenant",
    };

    const app = await createMSTeamsApp(creds, {
      messagingEndpoint: "/custom/webhook",
    });
    expect(app).toBeDefined();
  });
});

describe("createMSTeamsTokenProvider", () => {
  function createMockApp() {
    return {
      tokenManager: {
        getBotToken: async () => ({ toString: () => "bot-token" }),
        getGraphToken: async () => ({ toString: () => "graph-token" }),
      },
    } as unknown as import("./sdk.js").MSTeamsApp;
  }

  it("returns bot token for bot framework scope", async () => {
    const app = createMockApp();
    const provider = createMSTeamsTokenProvider(app);

    const token = await provider.getAccessToken("https://api.botframework.com");
    expect(token).toBe("bot-token");
  });

  it("returns graph token for graph scope", async () => {
    const app = createMockApp();
    const provider = createMSTeamsTokenProvider(app);

    const token = await provider.getAccessToken("https://graph.microsoft.com");
    expect(token).toBe("graph-token");
  });

  it("returns empty string when token is null", async () => {
    const app = {
      tokenManager: {
        getBotToken: async () => null,
        getGraphToken: async () => null,
      },
    } as unknown as import("./sdk.js").MSTeamsApp;
    const provider = createMSTeamsTokenProvider(app);

    expect(await provider.getAccessToken("https://api.botframework.com")).toBe("");
    expect(await provider.getAccessToken("https://graph.microsoft.com")).toBe("");
  });
});
