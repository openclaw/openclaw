import type { Api } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi, type Mock } from "vitest";
import {
  expectMockMessageContains,
  expectStatusCall,
  telegramMessageUpdate,
} from "./webhook-fixtures.js";
import { type createTelegramWebhookTestGateway, webhookUrl } from "./webhook-gateway.js";
import { postWebhookJson } from "./webhook-http.js";

type WebhookGateway = ReturnType<typeof createTelegramWebhookTestGateway>;
type RegistrationFixture = {
  gateway: WebhookGateway;
  setWebhookSpy: Mock<Api["setWebhook"]>;
  stopSpy: ReturnType<typeof vi.fn>;
  transportCloseSpies: Array<ReturnType<typeof vi.fn>>;
  startWebhookStartupFixture: (
    options?: Partial<Parameters<WebhookGateway["startWebhook"]>[0]>,
  ) => ReturnType<WebhookGateway["startWebhook"]>;
  requireWebhookQueueScope: () => { stateDir: string; accountId: string };
  token: string;
  secret: string;
  path: string;
};

export function registerTelegramWebhookRegistrationTests({
  gateway,
  setWebhookSpy,
  stopSpy,
  transportCloseSpies,
  startWebhookStartupFixture,
  requireWebhookQueueScope,
  token: TELEGRAM_TOKEN,
  secret: TELEGRAM_SECRET,
  path: TELEGRAM_WEBHOOK_PATH,
}: RegistrationFixture) {
  const { startWebhook: startTelegramWebhook, withWebhook: withStartedWebhook } = gateway;

  it("waits for setWebhook before reporting ready while continuing durable webhook admission", async () => {
    const advertised = createDeferred<void>();
    const retryStarted = createDeferred<void>();
    const retryRegistration = createDeferred<void>();
    const runtimeLog = vi.fn((message: unknown) => {
      if (typeof message === "string" && message.startsWith("webhook advertised to telegram on ")) {
        advertised.resolve();
      }
    });
    const runtimeError = vi.fn();
    const setStatus = vi.fn();
    setWebhookSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockImplementationOnce(async () => {
        retryStarted.resolve();
        await retryRegistration.promise;
        return true;
      });

    await withStartedWebhook(
      {
        secret: TELEGRAM_SECRET,
        path: TELEGRAM_WEBHOOK_PATH,
        runtime: { log: runtimeLog, error: runtimeError, exit: vi.fn() },
        setStatus,
        webhookRegistrationRetryPolicy: {
          initialMs: 0,
          maxMs: 0,
          factor: 1,
          jitter: 0,
        },
      },
      async ({ port }) => {
        try {
          await retryStarted.promise;
          const response = await postWebhookJson({
            url: webhookUrl(port, TELEGRAM_WEBHOOK_PATH),
            payload: JSON.stringify(telegramMessageUpdate(806, "startup webhook")),
            secret: TELEGRAM_SECRET,
          });
          expect(response.status).toBe(200);
          expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
          expect(stopSpy).not.toHaveBeenCalled();
          expectMockMessageContains(runtimeError, "telegram setWebhook failed: fetch failed");
          expect(setStatus).not.toHaveBeenCalledWith(
            expect.objectContaining({ lifecycle: "ready" }),
          );
          expect(setStatus).not.toHaveBeenCalledWith(expect.objectContaining({ connected: true }));
          expect(setStatus).toHaveBeenCalledWith({ lastEventAt: expect.any(Number) });
        } finally {
          retryRegistration.resolve();
        }
        await advertised.promise;
        expect(setWebhookSpy).toHaveBeenCalledTimes(2);
        expect(runtimeLog).toHaveBeenCalledWith("telegram setWebhook retry 1 scheduled in 0ms");
        expectMockMessageContains(runtimeLog, "webhook advertised to telegram on http://");
        expect(setStatus).toHaveBeenCalledWith({
          mode: "webhook",
          connected: false,
          lifecycle: "recovering",
          lastError: "fetch failed",
        });
        expectStatusCall(setStatus, { mode: "webhook", connected: true, lastError: null });
      },
    );
  });

  it("fails startup when setWebhook has a non-recoverable rejection", async () => {
    const runtimeError = vi.fn();
    const setStatus = vi.fn();
    const error = Object.assign(new Error("unauthorized"), { error_code: 401 });
    setWebhookSpy.mockRejectedValueOnce(error);

    await expect(
      startWebhookStartupFixture({
        path: TELEGRAM_WEBHOOK_PATH,
        runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
        setStatus,
      }),
    ).rejects.toThrow("unauthorized");

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);
    expectMockMessageContains(runtimeError, "telegram setWebhook failed: unauthorized");
    expectStatusCall(setStatus, {
      lifecycle: "blocked",
      terminalDisconnect: true,
      lastError: "unauthorized",
    });
  });

  it("does not mark a non-auth setWebhook rejection as blocked", async () => {
    const setStatus = vi.fn();
    const error = Object.assign(new Error("bad webhook URL"), { error_code: 400 });
    setWebhookSpy.mockRejectedValueOnce(error);

    await expect(
      startWebhookStartupFixture({
        path: TELEGRAM_WEBHOOK_PATH,
        setStatus,
      }),
    ).rejects.toThrow("bad webhook URL");

    const failedStatus = expectStatusCall(setStatus, { lastError: "bad webhook URL" });
    expect(failedStatus.lifecycle).toBeUndefined();
  });

  it("releases the Gateway route and stops the bot when retry loop encounters a non-recoverable error", async () => {
    const runtimeError = vi.fn();
    const stopped = createDeferred<void>();
    const setStatus = vi.fn((patch: { mode?: string; connected?: boolean }) => {
      if (
        patch.mode === "webhook" &&
        patch.connected === false &&
        Object.keys(patch).length === 2
      ) {
        stopped.resolve();
      }
    });
    const unauthorizedError = Object.assign(new Error("unauthorized"), { error_code: 401 });
    setWebhookSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(unauthorizedError);

    const started = await startTelegramWebhook({
      token: TELEGRAM_TOKEN,
      secret: TELEGRAM_SECRET,
      path: TELEGRAM_WEBHOOK_PATH,
      ...requireWebhookQueueScope(),
      runtime: { log: vi.fn(), error: runtimeError, exit: vi.fn() },
      setStatus,
      webhookRegistrationRetryPolicy: {
        initialMs: 0,
        maxMs: 0,
        factor: 1,
        jitter: 0,
      },
    });

    try {
      await stopped.promise;
      expect(gateway.registry.httpRoutes).toHaveLength(0);
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);
      expectStatusCall(setStatus, {
        lifecycle: "blocked",
        terminalDisconnect: true,
        lastError: "unauthorized",
      });
      expect(setStatus).toHaveBeenLastCalledWith({ mode: "webhook", connected: false });
      expectMockMessageContains(
        runtimeError,
        "telegram setWebhook retry stopped after non-recoverable error",
      );

      await started.stop();
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);
    } finally {
      await started.stop();
    }
  });
}
