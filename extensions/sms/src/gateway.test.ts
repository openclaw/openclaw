import type { IncomingMessage, ServerResponse } from "node:http";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { registerPluginHttpRoute as registerPluginHttpRouteType } from "openclaw/plugin-sdk/webhook-ingress";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectSmsStartupWarnings, startSmsGatewayAccount } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsTestAccount } from "./webhook.test-support.js";

const smsWebhookHandler = vi.hoisted(() => vi.fn(async (_req: unknown, _res: unknown) => true));
const createSmsWebhookHandler = vi.hoisted(() => vi.fn((_params: unknown) => smsWebhookHandler));
const tryHandleHostedSmsMediaRequest = vi.hoisted(() =>
  vi.fn(async (_req: unknown, _res: unknown, _accountId: string) => true),
);
const startSmsIngress = vi.hoisted(() => vi.fn());
const pauseSmsIngress = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const stopSmsIngress = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));
const createSmsIngressSpool = vi.hoisted(() =>
  vi.fn((_params: { abortSignal?: AbortSignal }) => ({
    enqueue: vi.fn(),
    start: startSmsIngress,
    pause: pauseSmsIngress,
    stop: stopSmsIngress,
  })),
);

const { registeredRoutes, routeUnregisters, registerPluginHttpRoute, waitUntilAbort } = vi.hoisted(
  () => {
    const routeCleanups: Array<() => void | Promise<void>> = [];
    const unregisters: Array<ReturnType<typeof vi.fn>> = [];
    return {
      registeredRoutes: routeCleanups,
      routeUnregisters: unregisters,
      registerPluginHttpRoute: vi.fn<typeof registerPluginHttpRouteType>(() => {
        const unregister = vi.fn();
        unregisters.push(unregister);
        return unregister;
      }),
      waitUntilAbort: vi.fn(async (_signal: AbortSignal, onAbort?: () => void | Promise<void>) => {
        if (onAbort) {
          routeCleanups.push(onAbort);
        }
      }),
    };
  },
);

vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({ waitUntilAbort }));

vi.mock("./ingress-spool.js", () => ({ createSmsIngressSpool }));
vi.mock("./media.js", () => ({ tryHandleHostedSmsMediaRequest }));
vi.mock("./webhook.js", () => ({ createSmsWebhookHandler }));

// mock-isolation: Gateway fixtures control webhook registration and request admission.
vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({ registerPluginHttpRoute }));

function createAccount(accountId: string, webhookPath = "/webhooks/sms"): ResolvedSmsAccount {
  return createSmsTestAccount({
    accountId,
    accountSid: `AC-${accountId}`,
    webhookPath,
    publicWebhookUrl: `https://gateway.example.com${webhookPath}`,
  });
}

function holdNextCall(mock: typeof stopSmsIngress) {
  let release: (() => void) | undefined;
  mock.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  return () => release?.();
}

describe("startSmsGatewayAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeUnregisters.length = 0;
  });

  afterEach(async () => {
    for (const unregister of registeredRoutes.toReversed()) {
      await unregister();
    }
    registeredRoutes.length = 0;
  });

  async function startRoute(
    params: Omit<
      Parameters<typeof startSmsGatewayAccount>[0],
      "abortSignal" | "cfg" | "channelRuntime"
    > = { account: createAccount("default") },
  ) {
    return await startSmsGatewayAccount({
      cfg: {},
      channelRuntime: {} as SmsChannelRuntime,
      ...params,
      abortSignal: new AbortController().signal,
    });
  }

  it("publishes ready and stopped around an active webhook route", async () => {
    const statusSink = vi.fn();
    await startRoute({ account: createAccount("default"), statusSink });

    expect(statusSink).toHaveBeenNthCalledWith(1, { lifecycle: "starting" });
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "ready", connected: true }),
    );
    expect(statusSink).toHaveBeenLastCalledWith(
      expect.objectContaining({ lifecycle: "stopped", running: false }),
    );
  });

  it.each([
    { config: { enabled: false }, expected: { lifecycle: "stopped", running: false } },
    { config: { authToken: "" }, expected: { lifecycle: "blocked", terminalDisconnect: true } },
  ])("publishes $expected.lifecycle without registering a route", async ({ config, expected }) => {
    const statusSink = vi.fn();
    await startRoute({ account: { ...createAccount("default"), ...config }, statusSink });
    expect(statusSink).toHaveBeenLastCalledWith(expect.objectContaining(expected));
    expect(registerPluginHttpRoute).not.toHaveBeenCalled();
  });

  it("stops ingress and rejects startup when the webhook route cannot bind", async () => {
    const statusSink = vi.fn();
    registerPluginHttpRoute.mockImplementationOnce(() => {
      throw new Error("SMS route conflict");
    });

    await expect(startRoute({ account: createAccount("default"), statusSink })).rejects.toThrow(
      "SMS route conflict",
    );

    expect(registerPluginHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({ throwOnFailure: true }),
    );
    expect(stopSmsIngress).toHaveBeenCalledOnce();
    expect(startSmsIngress).not.toHaveBeenCalled();
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
  });

  it("rejects duplicate webhook paths after route normalization", async () => {
    await startRoute();

    await expect(startRoute({ account: createAccount("support", "webhooks/sms") })).rejects.toThrow(
      /already registered by account default/u,
    );
    expect(registerPluginHttpRoute).toHaveBeenCalledTimes(1);
  });

  it("serves hosted media and Twilio callbacks from one exact route", async () => {
    await startRoute();

    const route = expectDefined(registerPluginHttpRoute.mock.calls[0]?.[0], "SMS webhook route");
    expect(route).toMatchObject({ path: "/webhooks/sms" });
    expect(route.match).toBeUndefined();

    for (const method of ["GET", "HEAD"]) {
      const req = { method } as IncomingMessage;
      const res = {} as ServerResponse;
      await route.handler(req, res);
      expect(tryHandleHostedSmsMediaRequest).toHaveBeenCalledWith(req, res, "default");
      expect(smsWebhookHandler).not.toHaveBeenCalled();
    }

    tryHandleHostedSmsMediaRequest.mockResolvedValueOnce(false);
    const postReq = { method: "POST" } as IncomingMessage;
    const postRes = {} as ServerResponse;
    await route.handler(postReq, postRes);
    expect(smsWebhookHandler).toHaveBeenCalledWith(postReq, postRes);
    expect(tryHandleHostedSmsMediaRequest).toHaveBeenCalledTimes(3);
  });

  it.each(["replacement", "abort cleanup"])(
    "keeps a replacement live during predecessor %s",
    async (mode) => {
      const releaseStop = holdNextCall(stopSmsIngress);
      await startRoute();

      const firstReplacement = mode === "replacement" ? startRoute() : registeredRoutes[0]?.();
      await vi.waitFor(() => expect(stopSmsIngress).toHaveBeenCalledTimes(1));
      if (mode === "replacement") {
        expect(registerPluginHttpRoute).toHaveBeenCalledTimes(2);
        expect(startSmsIngress).toHaveBeenCalledTimes(1);
      }
      const replacement = startRoute();
      await Promise.resolve();

      expect(registerPluginHttpRoute).toHaveBeenCalledTimes(mode === "replacement" ? 3 : 2);
      expect(startSmsIngress).toHaveBeenCalledTimes(1);
      releaseStop();
      await Promise.all([firstReplacement, replacement]);
      expect(startSmsIngress).toHaveBeenCalledTimes(2);
    },
  );

  it("binds replacement abort cleanup before its predecessor finishes stopping", async () => {
    const releaseStop = holdNextCall(stopSmsIngress);
    await startRoute();

    const replacement = startRoute();
    await vi.waitFor(() => expect(registeredRoutes).toHaveLength(2));
    await vi.waitFor(() => expect(stopSmsIngress).toHaveBeenCalledTimes(1));
    const abortReplacement = registeredRoutes[1]?.();

    expect(routeUnregisters[1]).toHaveBeenCalledOnce();
    releaseStop();
    await Promise.all([replacement, abortReplacement]);
    expect(startSmsIngress).toHaveBeenCalledTimes(1);
  });

  it("stops both ingress instances when predecessor pause fails", async () => {
    await startRoute();
    let replacementLifecycleSignal: AbortSignal | undefined;
    waitUntilAbort.mockImplementationOnce(async (signal, onAbort) => {
      replacementLifecycleSignal = signal;
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await onAbort?.();
    });
    pauseSmsIngress.mockRejectedValueOnce(new Error("pause failed"));

    await expect(startRoute()).rejects.toThrow("pause failed");

    expect(replacementLifecycleSignal?.aborted).toBe(true);
    expect(stopSmsIngress).toHaveBeenCalledTimes(2);
    registeredRoutes.length = 0;
  });

  it("pauses the predecessor pump before exposing a replacement route", async () => {
    const releasePause = holdNextCall(pauseSmsIngress);
    await startRoute();

    const replacement = startRoute();
    await vi.waitFor(() => expect(registerPluginHttpRoute).toHaveBeenCalledTimes(2));

    expect(pauseSmsIngress).toHaveBeenCalledTimes(1);
    expect(stopSmsIngress).not.toHaveBeenCalled();
    expect(createSmsIngressSpool.mock.calls[0]?.[0]).not.toHaveProperty("abortSignal");
    releasePause();
    await replacement;
    expect(stopSmsIngress).toHaveBeenCalledTimes(1);
  });
});

describe("collectSmsStartupWarnings", () => {
  it("reports an unusable public webhook URL without disabling outbound SMS", () => {
    expect(
      collectSmsStartupWarnings({
        ...createAccount("default"),
        publicWebhookUrl: "https://sms_gateway.example.com/webhooks/sms",
      }),
    ).toContain(
      "- SMS: publicWebhookUrl must be a properly encoded absolute HTTP(S) URL with a valid hostname, no embedded credentials, and remain within OpenClaw's 4,000-character callback safety limit; OpenClaw will omit the per-message delivery callback until fixed.",
    );
  });
});
