// RCS tests cover gateway route registration.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectRcsStartupWarnings, startRcsGatewayAccount } from "./gateway.js";
import type { RcsChannelRuntime } from "./inbound.js";
import type { ResolvedRcsAccount } from "./types.js";

function acceptedRouteHandle(): () => void {
  return vi.fn();
}

const registerPluginHttpRoute = vi.hoisted(() =>
  vi.fn((_route: { path: string }): (() => void) => acceptedRouteHandle()),
);

const registeredRoutes: Array<() => void | Promise<void>> = [];
const waitUntilAbort = vi.hoisted(() =>
  vi.fn(async (_signal: AbortSignal, onAbort?: () => void | Promise<void>) => {
    if (onAbort) {
      registeredRoutes.push(onAbort);
    }
  }),
);

const ingressStart = vi.hoisted(() => vi.fn());
const ingressPause = vi.hoisted(() => vi.fn(async () => undefined));
const ingressStop = vi.hoisted(() => vi.fn(async () => undefined));
const ingressEnqueue = vi.hoisted(() => vi.fn(async () => ({ duplicate: false })));
const createRcsIngressSpool = vi.hoisted(() =>
  vi.fn(() => ({
    start: ingressStart,
    pause: ingressPause,
    stop: ingressStop,
    enqueue: ingressEnqueue,
  })),
);

vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({ waitUntilAbort }));

vi.mock("./ingress-spool.js", () => ({ createRcsIngressSpool }));

vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  createFixedWindowRateLimiter: () => ({
    clear: vi.fn(),
    isRateLimited: vi.fn(() => false),
    size: vi.fn(() => 0),
  }),
  readRequestBodyWithLimit: vi.fn(async () => ""),
  registerPluginHttpRoute,
}));

function createAccount(overrides: Partial<ResolvedRcsAccount> = {}): ResolvedRcsAccount {
  return {
    accountId: "default",
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    messagingServiceSid: "MG123",
    senderId: "",
    transport: "rcs-only",
    defaultTo: "",
    webhookPath: "/webhooks/rcs",
    publicWebhookUrl: "https://gateway.example.com/webhooks/rcs",
    sharedWebhookPath: "",
    sharedWebhookPublicUrl: "",
    smsForwardWebhookPath: "",
    statusCallbacks: true,
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 3000,
    ...overrides,
  };
}

describe("startRcsGatewayAccount route registration", () => {
  beforeEach(() => {
    registerPluginHttpRoute.mockReset();
    registerPluginHttpRoute.mockImplementation(() => acceptedRouteHandle());
    waitUntilAbort.mockClear();
    createRcsIngressSpool.mockClear();
    ingressStart.mockClear();
    ingressPause.mockClear();
    ingressStop.mockClear();
    ingressEnqueue.mockClear();
  });

  afterEach(async () => {
    for (const unregister of registeredRoutes.toReversed()) {
      await unregister();
    }
    registeredRoutes.length = 0;
  });

  async function startRoute(account: ResolvedRcsAccount) {
    return await startRcsGatewayAccount({
      cfg: {},
      account,
      abortSignal: new AbortController().signal,
      channelRuntime: {} as RcsChannelRuntime,
    });
  }

  it("registers regular, status, and shared Twilio webhook routes", async () => {
    await startRoute(
      createAccount({
        sharedWebhookPath: "/webhooks/sms",
        sharedWebhookPublicUrl: "https://gateway.example.com/webhooks/sms",
        smsForwardWebhookPath: "/webhooks/sms/native",
      }),
    );

    expect(registerPluginHttpRoute).toHaveBeenCalledTimes(3);
    expect(registerPluginHttpRoute.mock.calls.map((call) => call[0].path)).toEqual([
      "/webhooks/rcs",
      "/webhooks/rcs/status",
      "/webhooks/sms",
    ]);
    expect(ingressStart).toHaveBeenCalledTimes(1);
  });

  // Startup order 1 (SMS-first-then-RCS): the SMS channel already owns the shared
  // Twilio path, so core rejects the RCS registration for it. RCS must fail loudly
  // instead of recording the no-op unregister and going silently dark.
  it("fails startup when another channel already owns the shared Twilio path", async () => {
    registerPluginHttpRoute.mockImplementation((route: { path: string }) =>
      route.path === "/webhooks/sms"
        ? (() => {
            throw new Error("plugin: route conflict at /webhooks/sms");
          })()
        : acceptedRouteHandle(),
    );

    await expect(
      startRoute(
        createAccount({
          sharedWebhookPath: "/webhooks/sms",
          sharedWebhookPublicUrl: "https://gateway.example.com/webhooks/sms",
          smsForwardWebhookPath: "/webhooks/sms/native",
        }),
      ),
    ).rejects.toThrow(/route conflict at \/webhooks\/sms/u);
    expect(ingressStart).not.toHaveBeenCalled();
    expect(ingressStop).toHaveBeenCalledTimes(1);
  });

  // The dedicated RCS inbound path can also collide when a sibling channel claimed
  // it first; the same fail-fast applies to every route RCS registers.
  it("fails startup when the dedicated RCS inbound path is already owned", async () => {
    registerPluginHttpRoute.mockImplementation((route: { path: string }) =>
      route.path === "/webhooks/rcs"
        ? (() => {
            throw new Error("plugin: route conflict at /webhooks/rcs");
          })()
        : acceptedRouteHandle(),
    );

    await expect(startRoute(createAccount())).rejects.toThrow(/route conflict at \/webhooks\/rcs/u);
    expect(ingressStart).not.toHaveBeenCalled();
    expect(ingressStop).toHaveBeenCalledTimes(1);
  });

  // A collision on a later route must not leak the routes registered before it.
  it("rolls back already-registered routes when a later route collides", async () => {
    const unregisters: Array<ReturnType<typeof vi.fn>> = [];
    registerPluginHttpRoute.mockImplementation((route: { path: string }) => {
      if (route.path === "/webhooks/sms") {
        throw new Error("plugin: route conflict at /webhooks/sms");
      }
      const fn = vi.fn();
      unregisters.push(fn);
      return fn;
    });

    await expect(
      startRoute(
        createAccount({
          sharedWebhookPath: "/webhooks/sms",
          sharedWebhookPublicUrl: "https://gateway.example.com/webhooks/sms",
          smsForwardWebhookPath: "/webhooks/sms/native",
        }),
      ),
    ).rejects.toThrow(/route conflict at \/webhooks\/sms/u);

    // inbound + status were registered before the shared-path collision; both
    // must be torn down so a failed startup leaves no dangling routes.
    expect(unregisters).toHaveLength(2);
    for (const unregister of unregisters) {
      expect(unregister).toHaveBeenCalledTimes(1);
    }
    expect(ingressStart).not.toHaveBeenCalled();
    expect(ingressStop).toHaveBeenCalledTimes(1);
  });
});

describe("collectRcsStartupWarnings", () => {
  it("requires forwarding and signature config for shared Twilio webhooks", () => {
    expect(
      collectRcsStartupWarnings(createAccount({ sharedWebhookPath: "/webhooks/sms" })),
    ).toEqual(
      expect.arrayContaining([
        "- RCS: smsForwardWebhookPath is required when sharedWebhookPath is set.",
        "- RCS: sharedWebhookPublicUrl is required for shared Twilio webhook signature validation.",
      ]),
    );
  });

  it("requires the shared webhook path to differ from the dedicated RCS path", () => {
    expect(
      collectRcsStartupWarnings(
        createAccount({
          sharedWebhookPath: "/webhooks/rcs",
          sharedWebhookPublicUrl: "https://gateway.example.com/webhooks/rcs",
          smsForwardWebhookPath: "/webhooks/sms/native",
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "- RCS: a sharedWebhookPath distinct from webhookPath is required; the shared Twilio route cannot replace the dedicated RCS route.",
      ]),
    );
  });

  it("requires the SMS forward path to differ from the shared webhook path", () => {
    expect(
      collectRcsStartupWarnings(
        createAccount({
          sharedWebhookPath: "/webhooks/sms",
          sharedWebhookPublicUrl: "https://gateway.example.com/webhooks/sms",
          smsForwardWebhookPath: "webhooks/sms",
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "- RCS: an smsForwardWebhookPath distinct from sharedWebhookPath is required; forwarding the shared webhook to itself would loop.",
      ]),
    );
  });

  it("accepts a distinct shared webhook and forward path pair", () => {
    expect(
      collectRcsStartupWarnings(
        createAccount({
          sharedWebhookPath: "/webhooks/sms",
          sharedWebhookPublicUrl: "https://gateway.example.com/webhooks/sms",
          smsForwardWebhookPath: "/webhooks/sms/native",
        }),
      ),
    ).toEqual([]);
  });
});
