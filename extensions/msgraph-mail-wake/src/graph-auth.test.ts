// Microsoft Graph Mail Wake tests cover Graph auth behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeApi from "../runtime-api.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { createGraphTokenProvider } from "./graph-auth.js";

vi.mock("../runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-api.js")>();
  return {
    ...actual,
    resolveConfiguredSecretInputString: vi.fn(async (params: { value: unknown }) => ({
      value: typeof params.value === "string" && params.value ? params.value : undefined,
    })),
  };
});

vi.mock("@azure/identity", () => {
  const instances: { args: unknown[]; getToken: ReturnType<typeof vi.fn> }[] = [];
  class FakeClientSecretCredential {
    getToken = vi.fn(async () => ({ token: "graph-token" }));
    constructor(...args: unknown[]) {
      instances.push({ args, getToken: this.getToken });
    }
  }
  return { ClientSecretCredential: FakeClientSecretCredential, fakeCredentialInstances: instances };
});

const resolveSecretMock = vi.mocked(runtimeApi.resolveConfiguredSecretInputString);

async function credentialInstances(): Promise<
  { args: unknown[]; getToken: ReturnType<typeof vi.fn> }[]
> {
  const azure = (await import("@azure/identity")) as unknown as {
    fakeCredentialInstances: { args: unknown[]; getToken: ReturnType<typeof vi.fn> }[];
  };
  return azure.fakeCredentialInstances;
}

beforeEach(async () => {
  resolveSecretMock.mockClear();
  (await credentialInstances()).length = 0;
});

describe("createGraphTokenProvider", () => {
  it("resolves static bearer tokens per call so rotated values are picked up", async () => {
    const provider = createGraphTokenProvider({
      auth: { bearerToken: "static-token" },
      config: {} as OpenClawConfig,
      authConfigPath: "plugins.entries.msgraph-mail-wake.config.auth",
    });

    await expect(provider.getAccessToken()).resolves.toBe("static-token");
    await expect(provider.getAccessToken()).resolves.toBe("static-token");
    expect(resolveSecretMock).toHaveBeenCalledTimes(2);
  });

  it("builds the client credential once but requests a fresh token per call", async () => {
    const provider = createGraphTokenProvider({
      auth: { tenantId: "tenant", clientId: "client", clientSecret: "secret" },
      config: {} as OpenClawConfig,
      authConfigPath: "plugins.entries.msgraph-mail-wake.config.auth",
    });

    await expect(provider.getAccessToken()).resolves.toBe("graph-token");
    await expect(provider.getAccessToken()).resolves.toBe("graph-token");
    // The credential (and its resolved secret) is built once; token
    // acquisition itself is delegated to @azure/identity every call so its
    // internal cache can renew expiring tokens.
    const instances = await credentialInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]?.args).toEqual(["tenant", "client", "secret"]);
    expect(instances[0]?.getToken).toHaveBeenCalledTimes(2);
    expect(instances[0]?.getToken).toHaveBeenCalledWith("https://graph.microsoft.com/.default");
  });
});
