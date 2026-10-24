import type { Api } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi, type Mock } from "vitest";
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
  token,
  secret,
  path,
}: RegistrationFixture) {
  const webhookOptions = { secret, path };
  let runtime: { log: Mock<(message: unknown) => void>; error: Mock; exit: Mock };
  let setStatus: Mock<(patch: { mode?: string; connected?: boolean }) => void>;
  beforeEach(() => {
    runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    setStatus = vi.fn();
  });
  const start = () => startWebhookStartupFixture({ path, runtime, setStatus });
  const apiError = (message: string, error_code: number) =>
    Object.assign(new Error(message), { error_code });
  const expectStopped = () => {
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(transportCloseSpies[0]).toHaveBeenCalledTimes(1);
  };

  it("waits for setWebhook before reporting ready while continuing durable webhook admission", async () => {
    const advertised = createDeferred<void>();
    const retryStarted = createDeferred<void>();
    const retryRegistration = createDeferred<void>();
    runtime.log.mockImplementation((message) => {
      if (typeof message === "string" && message.startsWith("webhook advertised to telegram on ")) {
        advertised.resolve();
      }
    });
    setWebhookSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockImplementationOnce(async () => {
        retryStarted.resolve();
        await retryRegistration.promise;
        return true;
      });

    await gateway.withWebhook(
      {
        ...webhookOptions,
        runtime,
        setStatus,
      },
      async ({ port }) => {
        try {
          await retryStarted.promise;
          const response = await postWebhookJson({
            url: webhookUrl(port, path),
            payload: JSON.stringify(telegramMessageUpdate(806, "startup webhook")),
            secret,
          });
          expect(response.status).toBe(200);
          expect(response.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
          expect(stopSpy).not.toHaveBeenCalled();
          expectMockMessageContains(runtime.error, "telegram setWebhook failed: fetch failed");
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
        expect(runtime.log).toHaveBeenCalledWith("telegram setWebhook retry 1 scheduled in 0ms");
        expectMockMessageContains(runtime.log, "webhook advertised to telegram on http://");
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
    setWebhookSpy.mockRejectedValueOnce(apiError("unauthorized", 401));
    await expect(start()).rejects.toThrow("unauthorized");
    expectStopped();
    expectMockMessageContains(runtime.error, "telegram setWebhook failed: unauthorized");
    expectStatusCall(setStatus, {
      lifecycle: "blocked",
      terminalDisconnect: true,
      lastError: "unauthorized",
    });
  });

  it("does not mark a non-auth setWebhook rejection as blocked", async () => {
    setWebhookSpy.mockRejectedValueOnce(apiError("bad webhook URL", 400));
    await expect(start()).rejects.toThrow("bad webhook URL");
    const failedStatus = expectStatusCall(setStatus, { lastError: "bad webhook URL" });
    expect(failedStatus.lifecycle).toBeUndefined();
  });

  it("releases the Gateway route and stops the bot when retry loop encounters a non-recoverable error", async () => {
    const stopped = createDeferred<void>();
    setStatus.mockImplementation((patch) => {
      if (
        patch.mode === "webhook" &&
        patch.connected === false &&
        Object.keys(patch).length === 2
      ) {
        stopped.resolve();
      }
    });
    setWebhookSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(apiError("unauthorized", 401));

    const started = await gateway.startWebhook({
      token,
      ...webhookOptions,
      ...requireWebhookQueueScope(),
      runtime,
      setStatus,
    });

    try {
      await stopped.promise;
      expect(gateway.registry.httpRoutes).toHaveLength(0);
      expectStopped();
      expectStatusCall(setStatus, {
        lifecycle: "blocked",
        terminalDisconnect: true,
        lastError: "unauthorized",
      });
      expect(setStatus).toHaveBeenLastCalledWith({ mode: "webhook", connected: false });
      expectMockMessageContains(
        runtime.error,
        "telegram setWebhook retry stopped after non-recoverable error",
      );

      await started.stop();
      expectStopped();
    } finally {
      await started.stop();
    }
  });
}
