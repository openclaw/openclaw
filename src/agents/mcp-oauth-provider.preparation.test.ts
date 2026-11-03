import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import type { McpOAuthStore } from "./mcp-oauth-store.js";

const { read, update, context, lease } = vi.hoisted(() => ({
  read: vi.fn(),
  update: vi.fn(),
  lease: {
    signal: new AbortController().signal,
    assertCurrent() {},
    async assertOwned() {},
    async renew() {},
  },
  context: {
    admission: {
      coordinationKey: "synthetic-state",
      databasePath: "/synthetic/mcp/state.sqlite",
      identity: { key: "synthetic-state", canonicalPath: "/synthetic/mcp/state.sqlite" },
      assertCurrent() {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic/mcp" },
  },
}));

vi.mock("./mcp-oauth-store.js", () => ({
  readMcpOAuthStore: read,
  mutateMcpOAuthStore: update,
}));

import { createMcpOAuthClientProvider } from "./mcp-oauth-provider.js";

const providerParams = {
  lease,
  storeContext: context,
  identity: operatorMcpOAuthIdentity("synthetic", "https://mcp.example.test"),
} satisfies Parameters<typeof createMcpOAuthClientProvider>[0];

function loginLifecycle(controller: AbortController) {
  return {
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
    onAuthorizationPublished() {},
    beforeTokensSaved() {},
    onTokensSaved() {},
  };
}

function expectRedirect(
  provider: Awaited<ReturnType<typeof createMcpOAuthClientProvider>>,
  redirectUrl: string,
) {
  expect(provider).toMatchObject({ redirectUrl, clientMetadata: { redirect_uris: [redirectUrl] } });
}

const original = { redirectUrl: "https://callback.example.test/original" };

beforeEach(() => {
  read.mockReset();
  update.mockReset();
});

it.each(["acknowledged", "uncertain"] as const)(
  "publishes metadata only after an %s write settles",
  async (outcome) => {
    const committed = {
      clientInformation: { client_id: "updated-client" },
      redirectUrl: "https://callback.example.test/updated",
    } satisfies McpOAuthStore;
    read.mockResolvedValueOnce(original);
    const provider = await createMcpOAuthClientProvider(providerParams);
    const failure = new Error("The write committed, but coordinator release failed");
    if (outcome === "uncertain") {
      update.mockRejectedValueOnce(failure);
      await expect(provider.saveClientInformation?.(committed.clientInformation)).rejects.toBe(
        failure,
      );
      expect(() => provider.redirectUrl).toThrow(failure);
      expect(() => provider.clientMetadata).toThrow(failure);
      read.mockResolvedValueOnce(committed);
      await provider.discoveryState?.();
    } else {
      update.mockResolvedValueOnce({ store: committed, applied: true });
      await provider.saveClientInformation?.(committed.clientInformation);
    }
    expectRedirect(provider, committed.redirectUrl);
  },
);

it("rejects tokens when its login lifecycle ends during a credential read", async () => {
  read.mockResolvedValueOnce(original);
  const controller = new AbortController();
  const provider = await createMcpOAuthClientProvider({
    ...providerParams,
    allowAuthorizationRedirect: true,
    login: loginLifecycle(controller),
  });
  const delayed = createDeferred<McpOAuthStore>();
  read.mockReturnValueOnce(delayed.promise);
  const result = provider.tokens();
  const failure = new Error("Login lifecycle ended");
  controller.abort(failure);
  delayed.resolve({
    tokens: { access_token: "late-access", token_type: "Bearer" },
    redirectUrl: "https://callback.example.test/late",
  });

  await expect(result).rejects.toBe(failure);
  expectRedirect(provider, original.redirectUrl);
});

it.each([
  { operation: "tokens", owner: "login" },
  { operation: "tokens", owner: "lease" },
  { operation: "codeVerifier", owner: "lease" },
] as const)(
  "rejects credential shortcuts after $owner ends ($operation)",
  async ({ operation, owner }) => {
    read.mockResolvedValue({});
    const failure = new Error("credential owner ended");
    const lifetime = new AbortController();
    const assertCurrent = () => {
      if (owner === "lease") {
        lifetime.signal.throwIfAborted();
      }
    };
    const provider = await createMcpOAuthClientProvider({
      ...providerParams,
      allowAuthorizationRedirect: true,
      suppressStoredTokens: operation === "tokens",
      lease: {
        ...lease,
        assertCurrent,
        async assertOwned() {
          assertCurrent();
        },
      },
      login: owner === "login" ? loginLifecycle(lifetime) : undefined,
    });
    if (operation === "codeVerifier") {
      await provider.saveCodeVerifier("fixture-prepared-verifier");
    }
    lifetime.abort(failure);
    await expect(provider[operation]()).rejects.toBe(failure);
  },
);
