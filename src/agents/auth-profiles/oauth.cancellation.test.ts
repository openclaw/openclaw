import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import "./oauth-common-mocks.test-support.js";
import { resolveApiKeyForProfile } from "./oauth.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const authMocks = vi.hoisted(() => ({
  resolveOAuthAccess: vi.fn(),
  loadAuthProfileStoreForRuntimeAsync: vi.fn(),
}));

vi.mock("./oauth-manager.js", () => ({
  createOAuthManager: () => ({
    resolveOAuthAccess: authMocks.resolveOAuthAccess,
    resetRefreshQueuesForTest: () => {},
  }),
}));

// mock-isolation: Cancellation races use synthetic auth snapshots without reading host stores.
vi.mock("./store-runtime.js", () => ({
  loadAuthProfileStoreForRuntimeAsync: authMocks.loadAuthProfileStoreForRuntimeAsync,
}));

it.each(["primary", "legacy fallback"])(
  "%s resolution does not return credentials when cancellation wins the race",
  async (route) => {
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: Date.now() + 600_000,
    };
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:default": { ...credential, access: "expired-access", expires: 1 },
        "openai:synthetic": credential,
      },
    };
    authMocks.resolveOAuthAccess.mockReset();
    authMocks.loadAuthProfileStoreForRuntimeAsync.mockResolvedValue(store);
    const controller = new AbortController();
    const managerStarted = createDeferredCore();
    const managerResult = createDeferredCore<{ apiKey: string; credential: OAuthCredential }>();
    authMocks.resolveOAuthAccess.mockImplementation(
      (params: { profileId: string; signal?: AbortSignal }) => {
        if (params.profileId === "openai:default") {
          return Promise.reject(new Error("synthetic refresh failure"));
        }
        if (params.signal === controller.signal) {
          managerStarted.resolve();
        }
        return managerResult.promise;
      },
    );
    const reason = new Error("credential lookup cancelled");
    const aborted = Symbol("aborted");
    const abortReceipt = createDeferredCore<typeof aborted>();
    const peer =
      route === "legacy fallback"
        ? resolveApiKeyForProfile({ cfg: {}, store, profileId: "openai:synthetic" })
        : undefined;
    const request = resolveApiKeyForProfile({
      cfg: {},
      store,
      profileId: route === "primary" ? "openai:synthetic" : "openai:default",
      signal: controller.signal,
    });
    const race = Promise.race([request, abortReceipt.promise]);
    await Promise.race([managerStarted.promise, request]);
    const cancellation = (peer ?? managerResult.promise).then(() => {
      controller.abort(reason);
      abortReceipt.resolve(aborted);
    });
    managerResult.resolve({ apiKey: credential.access, credential });

    let winner: Awaited<typeof race>;
    try {
      winner = await race;
    } catch (error) {
      expect(error).toBe(reason);
      return;
    } finally {
      await cancellation;
    }
    if (winner === aborted) {
      await expect(request).rejects.toBe(reason);
    } else {
      expect(winner).toMatchObject({
        apiKey: "synthetic-access",
        provider: "openai",
        profileId: "openai:synthetic",
      });
    }
  },
);
