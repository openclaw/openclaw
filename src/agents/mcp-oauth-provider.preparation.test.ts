import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { McpOAuthStore } from "./mcp-oauth-store.js";

const { read, update, context, lease } = vi.hoisted(() => ({
  read: vi.fn(),
  update: vi.fn(),
  lease: {
    signal: new AbortController().signal,
    async assertOwned() {},
    async renew() {},
  },
  context: {
    admission: {
      databasePath: "/synthetic/mcp/state.sqlite",
      identity: { key: "synthetic-state", canonicalPath: "/synthetic/mcp/state.sqlite" },
      assertCurrent() {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic/mcp" },
    coordinatorRuntime: { directory: "/synthetic/mcp/coordinator", keepAlive: false },
  },
}));

vi.mock("./mcp-oauth-store.js", () => ({
  readMcpOAuthStore: read,
  mutateMcpOAuthStore: update,
}));

import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";

beforeEach(() => {
  read.mockReset();
  update.mockReset();
});

it("keeps acknowledged metadata when an earlier read completes later", async () => {
  const original = {
    clientInformation: { client_id: "original-client" },
    redirectUrl: "https://callback.example.test/original",
  } satisfies McpOAuthStore;
  const committed = {
    clientInformation: { client_id: "updated-client" },
    redirectUrl: "https://callback.example.test/updated",
  } satisfies McpOAuthStore;
  read.mockResolvedValueOnce(original);
  const provider = await createMcpOAuthClientProvider({
    lease,
    storeContext: context,
    identity: {
      principal: "operator",
      storeKey: "synthetic-provider",
      serverName: "synthetic",
      serverUrl: "https://mcp.example.test",
    },
  });
  const earlier = createDeferred<McpOAuthStore>();
  read.mockReturnValueOnce(earlier.promise);
  const clientInformation = provider.clientInformation();
  update.mockResolvedValueOnce({ store: committed, applied: true });
  await provider.saveClientInformation?.(committed.clientInformation);
  expect(provider.redirectUrl).toBe(committed.redirectUrl);

  earlier.resolve(original);
  expect(await clientInformation).toEqual(original.clientInformation);
  expect(provider.redirectUrl).toBe(committed.redirectUrl);
  expect(provider.clientMetadata.redirect_uris).toEqual([committed.redirectUrl]);
});

it("requires an acknowledged read after a write reports an uncertain result", async () => {
  const original = { redirectUrl: "https://callback.example.test/original" };
  const committed = { redirectUrl: "https://callback.example.test/committed" };
  read.mockResolvedValueOnce(original);
  const provider = await createMcpOAuthClientProvider({
    lease,
    storeContext: context,
    identity: {
      principal: "operator",
      storeKey: "synthetic-provider",
      serverName: "synthetic",
      serverUrl: "https://mcp.example.test",
    },
  });
  const earlier = createDeferred<McpOAuthStore>();
  read.mockReturnValueOnce(earlier.promise);
  const information = provider.clientInformation();
  const failure = new Error("The write committed, but coordinator release failed");
  update.mockRejectedValueOnce(failure);
  await expect(provider.saveClientInformation?.({ client_id: "committed-client" })).rejects.toBe(
    failure,
  );
  earlier.resolve(original);
  await information;
  expect(() => provider.redirectUrl).toThrow(failure);
  expect(() => provider.clientMetadata).toThrow(failure);

  read.mockResolvedValueOnce(committed);
  await provider.discoveryState?.();
  expect(provider.redirectUrl).toBe(committed.redirectUrl);
  expect(provider.clientMetadata.redirect_uris).toEqual([committed.redirectUrl]);
});

it.each(["state", "clientInformation", "tokens", "codeVerifier", "discoveryState"] as const)(
  "rejects %s when its login lifecycle ends during a credential read",
  async (operation) => {
    const original = { redirectUrl: "https://callback.example.test/original" };
    read.mockResolvedValueOnce(original);
    const controller = new AbortController();
    const provider = await createMcpOAuthClientProvider({
      lease,
      storeContext: context,
      identity: {
        principal: "operator",
        storeKey: "synthetic-provider",
        serverName: "synthetic",
        serverUrl: "https://mcp.example.test",
      },
      allowAuthorizationRedirect: true,
      login: {
        signal: controller.signal,
        assertCurrent: () => controller.signal.throwIfAborted(),
        onAuthorizationPublished: vi.fn(),
        beforeTokensSaved: vi.fn(),
        onTokensSaved: vi.fn(),
      },
    });
    const delayed = createDeferred<McpOAuthStore>();
    read.mockReturnValueOnce(delayed.promise);
    const result = provider[operation]?.();
    const failure = new Error("Login lifecycle ended");
    controller.abort(failure);
    delayed.resolve({
      clientInformation: { client_id: "late-client" },
      tokens: { access_token: "late-access", token_type: "Bearer" },
      codeVerifier: "late-verifier",
      discoveryState: { authorizationServerUrl: "https://issuer.example.test" },
      redirectUrl: "https://callback.example.test/late",
    });

    await expect(result).rejects.toBe(failure);
    expect(provider.redirectUrl).toBe(original.redirectUrl);
    expect(provider.clientMetadata.redirect_uris).toEqual([original.redirectUrl]);
  },
);

it.each([
  { operation: "tokens", owner: "login" },
  { operation: "tokens", owner: "lease" },
  { operation: "codeVerifier", owner: "lease" },
] as const)(
  "rejects credential shortcuts after $owner ends ($operation)",
  async ({ operation, owner }) => {
    read.mockResolvedValue({});
    const failure = new Error("credential owner ended");
    const login = new AbortController();
    let leaseLive = true;
    const provider = await createMcpOAuthClientProvider({
      storeContext: context,
      identity: {
        principal: "operator",
        storeKey: "synthetic-provider",
        serverName: "synthetic",
        serverUrl: "https://mcp.example.test",
      },
      allowAuthorizationRedirect: true,
      suppressStoredTokens: operation === "tokens",
      lease: {
        signal: new AbortController().signal,
        async assertOwned() {
          if (!leaseLive) {
            throw failure;
          }
        },
        async renew() {},
      },
      login:
        owner === "login"
          ? {
              signal: login.signal,
              assertCurrent: () => login.signal.throwIfAborted(),
              onAuthorizationPublished() {},
              beforeTokensSaved() {},
              onTokensSaved() {},
            }
          : undefined,
    });
    if (operation === "codeVerifier") {
      await provider.saveCodeVerifier("fixture-prepared-verifier");
    }
    if (owner === "login") {
      login.abort(failure);
    } else {
      leaseLive = false;
    }
    await expect(provider[operation]()).rejects.toBe(failure);
  },
);
