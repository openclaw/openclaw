import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildHostnameAllowlistPolicyFromSuffixAllowlist: vi.fn((hosts: string[]) => ({
    hostnameAllowlist: hosts,
  })),
  fetchWithSsrFGuard: vi.fn(),
  gaxiosCtor: vi.fn(function MockGaxios(this: { defaults: Record<string, unknown> }, defaults) {
    this.defaults = defaults as Record<string, unknown>;
  }),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  buildHostnameAllowlistPolicyFromSuffixAllowlist:
    mocks.buildHostnameAllowlistPolicyFromSuffixAllowlist,
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("gaxios", () => ({
  Gaxios: mocks.gaxiosCtor,
}));

let __testing: typeof import("./google-auth.runtime.js").__testing;
let createGoogleAuthFetch: typeof import("./google-auth.runtime.js").createGoogleAuthFetch;
let getGoogleAuthTransport: typeof import("./google-auth.runtime.js").getGoogleAuthTransport;
let resolveValidatedGoogleChatCredentials: typeof import("./google-auth.runtime.js").resolveValidatedGoogleChatCredentials;

beforeAll(async () => {
  ({
    __testing,
    createGoogleAuthFetch,
    getGoogleAuthTransport,
    resolveValidatedGoogleChatCredentials,
  } = await import("./google-auth.runtime.js"));
});

beforeEach(() => {
  __testing.resetGoogleAuthRuntimeForTests();
  mocks.buildHostnameAllowlistPolicyFromSuffixAllowlist.mockClear();
  mocks.fetchWithSsrFGuard.mockReset();
  mocks.gaxiosCtor.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("googlechat google auth runtime", () => {
  it("routes Google auth fetches through the SSRF guard and strips proxy fields", async () => {
    const release = vi.fn();
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response("ok", { status: 200 }),
      release,
    });

    const guardedFetch = createGoogleAuthFetch();
    const response = await guardedFetch("https://oauth2.googleapis.com/token", {
      agent: { proxy: new URL("http://proxy.example:8080") },
      headers: { "content-type": "application/json" },
      method: "POST",
      proxy: "http://proxy.example:8080",
    } as RequestInit);

    expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith({
      auditContext: "googlechat.auth.google-auth",
      fetchImpl: expect.any(Function),
      init: {
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      policy: {
        hostnameAllowlist: ["accounts.google.com", "googleapis.com"],
      },
      url: "https://oauth2.googleapis.com/token",
    });
    await expect(response.text()).resolves.toBe("ok");
    expect(release).toHaveBeenCalledOnce();
  });

  it("builds a scoped Gaxios transport without mutating global window", async () => {
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Reflect.deleteProperty(globalThis as object, "window");
    try {
      const transport = await getGoogleAuthTransport();

      expect(mocks.gaxiosCtor).toHaveBeenCalledOnce();
      expect(transport).toMatchObject({
        defaults: {
          fetchImplementation: expect.any(Function),
        },
      });
      expect("window" in globalThis).toBe(false);
    } finally {
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      }
    }
  });

  it("rejects service-account credentials that override Google auth endpoints", async () => {
    await expect(
      resolveValidatedGoogleChatCredentials({
        accountId: "default",
        config: {},
        credentialSource: "inline",
        credentials: {
          client_email: "bot@example.iam.gserviceaccount.com",
          private_key: "key",
          token_uri: "https://evil.example/token",
          type: "service_account",
        },
        enabled: true,
      }),
    ).rejects.toThrow(/token_uri/);
  });

  it("reads and validates service-account files before passing them to google-auth", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "googlechat-auth-"));
    try {
      const credentialsPath = path.join(tempDir, "service-account.json");
      await fs.writeFile(
        credentialsPath,
        JSON.stringify({
          auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
          auth_uri: "https://accounts.google.com/o/oauth2/auth",
          client_email: "bot@example.iam.gserviceaccount.com",
          private_key: "key",
          token_uri: "https://oauth2.googleapis.com/token",
          type: "service_account",
          universe_domain: "googleapis.com",
        }),
        "utf8",
      );

      await expect(
        resolveValidatedGoogleChatCredentials({
          accountId: "default",
          config: {},
          credentialSource: "file",
          credentialsFile: credentialsPath,
          enabled: true,
        }),
      ).resolves.toMatchObject({
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

    await expect(
      resolveValidatedGoogleChatCredentials({
        accountId: "default",
        config: {},
        credentialSource: "file",
        credentialsFile: missingPath,
        enabled: true,
      }),
    ).rejects.toThrow("Failed to load Google Chat service account file.");

    await expect(
      resolveValidatedGoogleChatCredentials({
        accountId: "default",
        config: {},
        credentialSource: "file",
        credentialsFile: missingPath,
        enabled: true,
      }),
    ).rejects.not.toThrow(/ENOENT|service-account\.json|googlechat-auth-missing/);
  });
});
