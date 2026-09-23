// Sign-in routes use the installed SDK's OAuth handlers and event emitter.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  createConfig,
  createRuntime,
  createStores,
  installMonitorLifecycleTestHooks,
  isSigninInvokeAuthorized,
  loadMSTeamsSdkWithAuth,
  registerMSTeamsHandlers,
  ssoTokenStore,
  updateMSTeamsConfig,
  waitForMSTeamsTestState,
} from "./monitor.lifecycle.test-support.js";

const { monitorMSTeamsProvider } = await import("./monitor.js");

describe("monitorMSTeamsProvider SSO", () => {
  installMonitorLifecycleTestHooks();

  it("gates SDK SSO invoke routes and persists successful signin events", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      sso: { enabled: true, connectionName: "graph" },
    });

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    expect(loadMSTeamsSdkWithAuth.mock.calls[0]?.[1]).toMatchObject({
      oauthDefaultConnectionName: "graph",
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const sdkResult = await sdkResultPromise;
    const app = sdkResult.app;
    expect(app.on).toHaveBeenCalledWith("signin.token-exchange", expect.any(Function));
    expect(app.on).toHaveBeenCalledWith("signin.verify-state", expect.any(Function));
    expect(app.event).toHaveBeenCalledWith("signin", expect.any(Function));

    const tokenExchangeHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "signin.token-exchange",
    )?.[1];
    expect(typeof tokenExchangeHandler).toBe("function");
    if (typeof tokenExchangeHandler !== "function") {
      throw new Error("expected signin token-exchange handler");
    }
    const token = {
      connectionName: "graph",
      token: "delegated-graph-token",
      expiration: "2030-01-01T00:00:00Z",
    };
    const users = {
      exchangeToken: vi.fn(async () => token),
      getToken: vi.fn(async () => token),
    };
    const next = vi.fn();
    const context = {
      activity: {
        type: "invoke",
        channelId: "msteams",
        conversation: { id: "test-conversation" },
        from: { id: "29:user", aadObjectId: "aad-user" },
      },
      api: { users },
      log: { warn: vi.fn() },
      next,
    };
    const verifyStateHandler = app.on.mock.calls.find(
      (call: unknown[]) => call[0] === "signin.verify-state",
    )?.[1];
    if (typeof verifyStateHandler !== "function") {
      throw new Error("expected signin verify-state handler");
    }
    try {
      for (const [handler, name, value] of [
        [
          tokenExchangeHandler,
          "signin/tokenExchange",
          { id: "exchange-id", connectionName: "graph", token: "exchange-token" },
        ],
        [verifyStateHandler, "signin/verifyState", { state: "verification-code" }],
      ] as const) {
        const saved = createDeferred<void>();
        ssoTokenStore.save.mockClear().mockImplementation(async () => {
          if (ssoTokenStore.save.mock.calls.length === 2) {
            saved.resolve();
          }
        });
        await expect(
          handler({ ...context, activity: { ...context.activity, name, value } }),
        ).resolves.toEqual({ status: 200 });
        await saved.promise;
        expect(ssoTokenStore.save).toHaveBeenCalledWith(
          expect.objectContaining({
            connectionName: "graph",
            userId: "29:user",
            token: token.token,
            expiresAt: token.expiration,
          }),
        );
        expect(ssoTokenStore.save).toHaveBeenCalledWith(
          expect.objectContaining({
            connectionName: "graph",
            userId: "aad-user",
            token: token.token,
            expiresAt: token.expiration,
          }),
        );
      }
      expect(users.exchangeToken).toHaveBeenCalledWith({
        channelId: "msteams",
        userId: "29:user",
        connectionName: "graph",
        exchangeRequest: { token: "exchange-token" },
      });
      expect(users.getToken).toHaveBeenCalledWith({
        channelId: "msteams",
        userId: "29:user",
        connectionName: "graph",
        code: "verification-code",
      });
      expect(next).toHaveBeenCalledTimes(2);
      expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(4);
    } finally {
      abort.abort();
      await task;
    }
  });

  it("does not persist SDK SSO signin events when Teams sender policy denies them", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      sso: { enabled: true, connectionName: "graph" },
    });
    isSigninInvokeAuthorized.mockResolvedValueOnce(false);

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await waitForMSTeamsTestState(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const signinHandler = app.event.mock.calls.find((call: unknown[]) => call[0] === "signin")?.[1];
    if (typeof signinHandler !== "function") {
      throw new Error("expected signin event handler");
    }

    signinHandler({
      activity: { from: { id: "29:user", aadObjectId: "aad-user" } },
      token: {
        connectionName: "graph",
        token: "delegated-graph-token",
        expiration: "2030-01-01T00:00:00Z",
      },
    });

    await waitForMSTeamsTestState(() => {
      expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(1);
    });
    expect(ssoTokenStore.save).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it.each(["sender is denied", "SSO is disabled"])(
    "blocks SDK SSO invokes before Bot Framework when %s",
    async (reason) => {
      const abort = new AbortController();
      const cfg = createConfig(0);
      updateMSTeamsConfig(cfg, {
        sso: { enabled: reason !== "SSO is disabled", connectionName: "graph" },
      });
      isSigninInvokeAuthorized.mockResolvedValue(reason !== "sender is denied");

      const task = monitorMSTeamsProvider({
        cfg,
        runtime: createRuntime(),
        abortSignal: abort.signal,
        conversationStore: createStores().conversationStore,
        pollStore: createStores().pollStore,
      });

      await waitForMSTeamsTestState(() => {
        expect(registerMSTeamsHandlers).toHaveBeenCalled();
      });

      const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
      if (!sdkResultPromise) {
        throw new Error("expected loadMSTeamsSdkWithAuth result");
      }
      const app = (await sdkResultPromise).app;
      const users = { exchangeToken: vi.fn(), getToken: vi.fn() };
      try {
        for (const route of ["signin.token-exchange", "signin.verify-state"]) {
          const handler = app.on.mock.calls.find((call: unknown[]) => call[0] === route)?.[1];
          if (typeof handler !== "function") {
            throw new Error(`expected ${route} handler`);
          }
          await expect(
            handler({
              activity: { from: { id: "29:blocked", aadObjectId: "aad-blocked" } },
              api: { users },
            }),
          ).resolves.toEqual({ status: 200, body: {} });
        }
        expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(2);
        expect(users.exchangeToken).not.toHaveBeenCalled();
        expect(users.getToken).not.toHaveBeenCalled();
        expect(ssoTokenStore.save).not.toHaveBeenCalled();
      } finally {
        abort.abort();
        await task;
      }
    },
  );
});
