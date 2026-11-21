import { isDeepStrictEqual } from "node:util";
import type { Api } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi, type Mock } from "vitest";
import { expectStatusCall, telegramMessageUpdate } from "./webhook-fixtures.js";
import { type createTelegramWebhookTestGateway, webhookUrl } from "./webhook-gateway.js";
import { postWebhookJson } from "./webhook-http.js";

type Start = ReturnType<typeof createTelegramWebhookTestGateway>["startWebhook"];
type RegistrationFixture = {
  gateway: ReturnType<typeof createTelegramWebhookTestGateway>;
  setWebhookSpy: Mock<Api["setWebhook"]>;
  initSpy: Mock<() => Promise<void>>;
  stopSpy: ReturnType<typeof vi.fn>;
  transportCloseSpies: Array<ReturnType<typeof vi.fn>>;
  startWebhookStartupFixture: (options?: Partial<Parameters<Start>[0]>) => ReturnType<Start>;
  requireWebhookQueueScope: () => { stateDir: string; accountId: string };
  token: string;
  secret: string;
  path: string;
};

export function registerTelegramWebhookRegistrationTests(fixture: RegistrationFixture) {
  const { gateway, setWebhookSpy, initSpy, secret, path } = fixture;
  const webhookOptions = { secret, path };
  const runtime = { log() {}, error() {}, exit: vi.fn() };
  const disconnected = { mode: "webhook", connected: false };
  let setStatus: Mock<(patch: { mode?: string; connected?: boolean }) => void>;
  beforeEach(() => {
    setStatus = vi.fn();
  });
  const status = (expected: Record<string, unknown>) => expectStatusCall(setStatus, expected);
  const start = () => fixture.startWebhookStartupFixture({ path, runtime, setStatus });
  const apiError = (message: string, error_code: number) =>
    Object.assign(new Error(message), { error_code });
  const expectStopped = () => {
    expect(fixture.stopSpy).toHaveBeenCalledTimes(1);
    expect(fixture.transportCloseSpies[0]).toHaveBeenCalledTimes(1);
  };
  const expectBlocked = (message = "unauthorized") => {
    expectStopped();
    status({ lifecycle: "blocked", terminalDisconnect: true, lastError: message });
  };

  it("retries transient getMe startup init failures before starting the account", async () => {
    using now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const retryStarted = createDeferred<void>();
    const releaseRetry = createDeferred<void>();
    initSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockImplementationOnce(async () => {
        retryStarted.resolve();
        await releaseRetry.promise;
      });

    const running = gateway.withWebhook(
      { ...webhookOptions, runtime, setStatus },
      async ({ port }) => {
        const response = await postWebhookJson({
          url: webhookUrl(port, path),
          payload: JSON.stringify(telegramMessageUpdate(806, "startup webhook")),
          secret,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
        expect(await response.text()).toBe("");
      },
    );
    try {
      await retryStarted.promise;
      expect(expectStatusCall(setStatus, { lifecycle: "recovering" })).toEqual({
        mode: "webhook",
        connected: false,
        lifecycle: "recovering",
        lastDisconnect: { at: 1_000_000 },
      });
      expect(setWebhookSpy).not.toHaveBeenCalled();
      now.mockReturnValue(1_090_000);
    } finally {
      releaseRetry.resolve();
      await running;
    }
    expect(initSpy).toHaveBeenCalledTimes(2);
    expectStatusCall(setStatus, { lifecycle: "ready", connected: true, lastError: null });
    expect(setWebhookSpy).toHaveBeenCalledTimes(1);
  });

  it("waits for setWebhook before reporting ready while continuing durable webhook admission", async () => {
    using now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const advertised = createDeferred<void>();
    const retryStarted = createDeferred<void>();
    const retryRegistration = createDeferred<void>();
    setStatus.mockImplementation(({ connected }) => connected && advertised.resolve());
    setWebhookSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockImplementationOnce(async () => {
        now.mockReturnValue(1_090_000);
        throw apiError("service unavailable", 503);
      })
      .mockImplementationOnce(async () => {
        retryStarted.resolve();
        await retryRegistration.promise;
        return true;
      });

    await gateway.withWebhook({ ...webhookOptions, runtime, setStatus }, async ({ port }) => {
      try {
        await retryStarted.promise;
        expect(status({ lastError: "fetch failed" }).lastDisconnect).toEqual({
          at: 1_000_000,
          error: "fetch failed",
        });
        expect(status({ lastError: "service unavailable" }).lastDisconnect).toEqual({
          at: 1_000_000,
          error: "service unavailable",
        });
        const response = await postWebhookJson({
          url: webhookUrl(port, path),
          payload: JSON.stringify(telegramMessageUpdate(806, "startup webhook")),
          secret,
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
        expect(fixture.stopSpy).not.toHaveBeenCalled();
        expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
        expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
        expect(setStatus).toHaveBeenCalledWith({ lastEventAt: expect.any(Number) });
      } finally {
        retryRegistration.resolve();
      }
      await advertised.promise;
      expect(setStatus).toHaveBeenCalledWith({
        ...disconnected,
        lifecycle: "recovering",
        lastError: "fetch failed",
        lastDisconnect: { at: 1_000_000, error: "fetch failed" },
      });
      status({ mode: "webhook", connected: true, lastError: null });
    });
  });

  it.each([
    [401, "unauthorized"],
    [404, "not found"],
    [400, "bad webhook URL"],
  ] as const)("rejects setWebhook %s: %s", async (code, message) => {
    setWebhookSpy.mockRejectedValueOnce(apiError(message, code));
    await expect(start()).rejects.toThrow(message);
    if (code === 401 || code === 404) {
      expectBlocked(message);
    } else {
      expect(status({ lastError: message }).lifecycle).toBeUndefined();
    }
  });

  it("releases the Gateway route and stops the bot when retry loop encounters a non-recoverable error", async () => {
    const stopped = createDeferred<void>();
    setStatus.mockImplementation(
      (patch) => isDeepStrictEqual(patch, disconnected) && stopped.resolve(),
    );
    setWebhookSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(apiError("unauthorized", 401));

    await gateway.withWebhook({ ...webhookOptions, runtime, setStatus }, async ({ stop }) => {
      await stopped.promise;
      expect(gateway.registry.httpRoutes).toHaveLength(0);
      expectBlocked();
      expect(setStatus).toHaveBeenLastCalledWith(disconnected);

      await stop();
      expectStopped();
    });
  });
}
