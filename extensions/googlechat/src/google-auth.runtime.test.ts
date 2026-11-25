// Googlechat tests cover google auth plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  getGoogleAuthTransport,
  loadGoogleAuthRuntime,
  resolveValidatedGoogleChatCredentials,
} from "./google-auth.runtime.js";

const mocks = vi.hoisted(() => ({
  buildHostnameAllowlistPolicyFromSuffixAllowlist: vi.fn((hosts: string[]) => ({
    hostnameAllowlist: hosts,
  })),
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  buildHostnameAllowlistPolicyFromSuffixAllowlist:
    mocks.buildHostnameAllowlistPolicyFromSuffixAllowlist,
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

beforeEach(() => {
  mocks.buildHostnameAllowlistPolicyFromSuffixAllowlist.mockClear();
  mocks.fetchWithSsrFGuard.mockReset();
  stubIsolatedProcessEnv({
    HTTP_PROXY: "",
    http_proxy: "",
    HTTPS_PROXY: "",
    https_proxy: "",
    NO_PROXY: "",
    no_proxy: "",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function stubIsolatedProcessEnv(patch: NodeJS.ProcessEnv): void {
  const isolatedProcess = Object.create(process) as NodeJS.Process;
  Object.defineProperty(isolatedProcess, "env", {
    configurable: true,
    value: { ...process.env, ...patch },
  });
  // Test files share the host process environment. Replace only this file's
  // global view so proxy-policy coverage cannot redirect sibling transports.
  vi.stubGlobal("process", isolatedProcess);
}

type GoogleAuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function createGoogleAuthTransportFetch(): Promise<GoogleAuthFetch> {
  const transport = await getGoogleAuthTransport();
  const fetchImplementation = (transport.defaults as { fetchImplementation?: GoogleAuthFetch })
    .fetchImplementation;
  if (!fetchImplementation) {
    throw new Error("Expected Google auth transport fetch implementation");
  }
  return fetchImplementation;
}

function mockGuardedResponse(response = new Response("ok", { status: 200 })) {
  const release = vi.fn();
  mocks.fetchWithSsrFGuard.mockResolvedValueOnce({ response, release });
  return release;
}

function credentialsAccount(
  overrides: Pick<ResolvedGoogleChatAccount, "credentialSource"> &
    Partial<ResolvedGoogleChatAccount>,
): ResolvedGoogleChatAccount {
  return { accountId: "default", config: {}, enabled: true, ...overrides };
}

function createUnstreamedAuthResponse(headers?: HeadersInit) {
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(16));
  return {
    arrayBuffer,
    response: {
      arrayBuffer,
      body: null,
      headers: new Headers(headers),
      status: 200,
      statusText: "OK",
    } as unknown as Response,
  };
}

const validCredentials = {
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  client_email: "bot@example.iam.gserviceaccount.com",
  private_key: "key",
  token_uri: "https://oauth2.googleapis.com/token",
  type: "service_account",
  universe_domain: "googleapis.com",
};

describe("googlechat google auth runtime", () => {
  it.each([
    ["explicit proxy", "http://proxy.example:8080/"],
    ["noProxy bypass", null],
    ["environment proxy", "http://env-proxy.example:8080/"],
  ] as const)("routes Google auth through the guard with %s and mTLS", async (mode, proxyUrl) => {
    const release = mockGuardedResponse();
    const controller = new AbortController();
    if (mode === "environment proxy") {
      stubIsolatedProcessEnv({
        HTTPS_PROXY: "http://env-proxy.example:8080",
        https_proxy: "http://lower-proxy.example:8080",
      });
    }
    const transport = await getGoogleAuthTransport();
    const response = await transport.request({
      url: "https://oauth2.googleapis.com/token",
      cert: "CLIENT_CERT",
      headers: { "content-type": "application/json" },
      key: "CLIENT_KEY",
      method: "POST",
      responseType: "text",
      signal: controller.signal,
      ...(mode !== "environment proxy" ? { proxy: "http://proxy.example:8080" } : {}),
      ...(mode === "noProxy bypass" ? { noProxy: ["oauth2.googleapis.com"] } : {}),
    });

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "googlechat.auth.google-auth",
        dispatcherPolicy: proxyUrl
          ? {
              allowPrivateProxy: true,
              mode: "explicit-proxy",
              proxyTls: { cert: "CLIENT_CERT", key: "CLIENT_KEY" },
              proxyUrl,
            }
          : { connect: { cert: "CLIENT_CERT", key: "CLIENT_KEY" }, mode: "direct" },
        init: expect.objectContaining({
          method: "POST",
          signal: controller.signal,
        }),
        policy: {
          hostnameAllowlist: ["accounts.google.com", "googleapis.com"],
        },
        signal: controller.signal,
        timeoutMs: 30_000,
        url: "https://oauth2.googleapis.com/token",
      }),
    );
    expect(response.data).toBe("ok");
    expect(mockCallArg(mocks.fetchWithSsrFGuard)).not.toHaveProperty("init.agent");
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps using the guard-selected runtime fetch even if global fetch changes later", async () => {
    const release = mockGuardedResponse();
    const originalFetch = globalThis.fetch;

    const guardedFetch = await createGoogleAuthTransportFetch();
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => new Response("patched"));

    try {
      await guardedFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
      } as RequestInit);
    } finally {
      (globalThis as Record<string, unknown>).fetch = originalFetch;
    }

    expect(mockCallArg(mocks.fetchWithSsrFGuard)).not.toHaveProperty("fetchImpl");
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    [
      undefined,
      "Google auth response body stream unavailable; refusing to buffer unbounded response.",
    ],
    [{ "content-length": String(2 * 1024 * 1024) }, "Google auth response exceeds 1048576 bytes."],
  ] as const)("rejects unsafe unstreamed auth responses (%j)", async (headers, message) => {
    const { response, arrayBuffer } = createUnstreamedAuthResponse(headers);
    const release = mockGuardedResponse(response);

    const guardedFetch = await createGoogleAuthTransportFetch();

    await expect(
      guardedFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
      } as RequestInit),
    ).rejects.toThrow(message);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps auth transports isolated from google-auth interceptor mutations", async () => {
    const first = await getGoogleAuthTransport();
    const second = await getGoogleAuthTransport();
    first.interceptors.request.add({
      resolved: async (config) => {
        config.headers.set("x-client-only", "first");
        return config;
      },
    });
    for (const transport of [first, second]) {
      mockGuardedResponse();
      await transport.request({ url: "https://oauth2.googleapis.com/token", responseType: "text" });
    }
    const firstRequest = mockCallArg(mocks.fetchWithSsrFGuard) as { init: RequestInit };
    const secondRequest = mockCallArg(mocks.fetchWithSsrFGuard, 1) as { init: RequestInit };
    expect(new Headers(firstRequest.init.headers).get("x-client-only")).toBe("first");
    expect(new Headers(secondRequest.init.headers).has("x-client-only")).toBe(false);
  });

  it("passes native request and response Headers through real Google auth interceptors", async () => {
    mockGuardedResponse(
      new Response("ok", { headers: { "cache-control": "public, max-age=3600" } }),
    );
    const transport = await getGoogleAuthTransport();
    const { OAuth2Client } = await loadGoogleAuthRuntime();
    const client = new OAuth2Client({ transporter: transport });
    const response = await client.transporter.request({
      url: "https://www.googleapis.com/oauth2/v1/certs",
      headers: { "x-test": "1" },
      responseType: "text",
    });
    const request = mockCallArg(mocks.fetchWithSsrFGuard) as { init: { headers: Headers } };
    expect(request.init.headers).toBeInstanceOf(Headers);
    expect(request.init.headers.get("x-test")).toBe("1");
    expect(request.init.headers.get("x-goog-api-client")).toContain("gl-node/");
    expect(response.headers).toBeInstanceOf(Headers);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("rejects service-account credentials that override Google auth endpoints", async () => {
    await expect(
      resolveValidatedGoogleChatCredentials(
        credentialsAccount({
          credentialSource: "inline",
          credentials: {
            client_email: "bot@example.iam.gserviceaccount.com",
            private_key: "key",
            token_uri: "https://evil.example/token",
            type: "service_account",
          },
        }),
      ),
    ).rejects.toThrow(/token_uri/);
  });

  it("reads and validates service-account files before passing them to google-auth", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "googlechat-auth-"));
    try {
      const credentialsPath = path.join(tempDir, "service-account.json");
      await fs.writeFile(credentialsPath, JSON.stringify(validCredentials), "utf8");

      const credentials = await resolveValidatedGoogleChatCredentials(
        credentialsAccount({
          credentialSource: "file",
          credentialsFile: credentialsPath,
        }),
      );
      expect(credentials).toMatchObject({
        client_email: "bot@example.iam.gserviceaccount.com",
        token_uri: "https://oauth2.googleapis.com/token",
        type: "service_account",
      });
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("does not disclose raw credential paths or OS errors when file reads fail", async () => {
    const missingPath = path.join(os.tmpdir(), "googlechat-auth-missing", "service-account.json");

    const thrown = await resolveValidatedGoogleChatCredentials(
      credentialsAccount({
        credentialSource: "file",
        credentialsFile: missingPath,
      }),
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Failed to load Google Chat service account file.");
    expect((thrown as Error).message).not.toMatch(
      /ENOENT|service-account\.json|googlechat-auth-missing/,
    );
  });
});
