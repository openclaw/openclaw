import type { IncomingMessage } from "node:http";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/googlechat";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { createMockServerResponse } from "../../../src/test-utils/mock-http-response.js";
import { verifyGoogleChatRequest } from "./auth.js";
import { handleGoogleChatWebhookRequest, registerGoogleChatWebhookTarget } from "./monitor.js";

vi.mock("./auth.js", () => ({
  verifyGoogleChatRequest: vi.fn(),
}));

function createWebhookRequest(params: {
  authorization?: string;
  payload: unknown;
  path?: string;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & {
    destroyed?: boolean;
    destroy: (error?: Error) => IncomingMessage;
    on: (event: string, listener: (...args: unknown[]) => void) => IncomingMessage;
  };
  req.method = "POST";
  req.url = params.path ?? "/googlechat";
  req.headers = {
    authorization: params.authorization ?? "",
    "content-type": "application/json",
  };
  req.destroyed = false;
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  req.destroy = () => {
    req.destroyed = true;
    return req;
  };

  const originalOn = req.on.bind(req);
  let bodyScheduled = false;
  req.on = ((event: string, listener: (...args: unknown[]) => void) => {
    const result = originalOn(event, listener);
    if (!bodyScheduled && event === "data") {
      bodyScheduled = true;
      void Promise.resolve().then(() => {
        req.emit("data", Buffer.from(JSON.stringify(params.payload), "utf-8"));
        if (!req.destroyed) {
          req.emit("end");
        }
      });
    }
    return result;
  }) as IncomingMessage["on"];

  return req;
}

function createHeaderOnlyWebhookRequest(params: {
  authorization?: string;
  path?: string;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "POST";
  req.url = params.path ?? "/googlechat";
  req.headers = {
    authorization: params.authorization ?? "",
    "content-type": "application/json",
  };
  (req as unknown as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: "127.0.0.1",
  };
  return req;
}

const baseAccount = (accountId: string) =>
  ({
    accountId,
    enabled: true,
    credentialSource: "none",
    config: {},
  }) as ResolvedGoogleChatAccount;

function registerTwoTargets() {
  const sinkA = vi.fn();
  const sinkB = vi.fn();
  const core = {} as PluginRuntime;
  const config = {} as OpenClawConfig;

  const unregisterA = registerGoogleChatWebhookTarget({
    account: baseAccount("A"),
    config,
    runtime: {},
    core,
    path: "/googlechat",
    statusSink: sinkA,
    mediaMaxMb: 5,
  });
  const unregisterB = registerGoogleChatWebhookTarget({
    account: baseAccount("B"),
    config,
    runtime: {},
    core,
    path: "/googlechat",
    statusSink: sinkB,
    mediaMaxMb: 5,
  });

  return {
    sinkA,
    sinkB,
    unregister: () => {
      unregisterA();
      unregisterB();
    },
  };
}

describe("Google Chat webhook routing", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("registers and unregisters plugin HTTP route at path boundaries", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    const unregisterA = registerGoogleChatWebhookTarget({
      account: baseAccount("A"),
      config: {} as OpenClawConfig,
      runtime: {},
      core: {} as PluginRuntime,
      path: "/googlechat",
      statusSink: vi.fn(),
      mediaMaxMb: 5,
    });
    const unregisterB = registerGoogleChatWebhookTarget({
      account: baseAccount("B"),
      config: {} as OpenClawConfig,
      runtime: {},
      core: {} as PluginRuntime,
      path: "/googlechat",
      statusSink: vi.fn(),
      mediaMaxMb: 5,
    });

    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]).toEqual(
      expect.objectContaining({
        pluginId: "googlechat",
        path: "/googlechat",
        source: "googlechat-webhook",
      }),
    );

    unregisterA();
    expect(registry.httpRoutes).toHaveLength(1);
    unregisterB();
    expect(registry.httpRoutes).toHaveLength(0);
  });

  it("rejects ambiguous routing when multiple targets on the same path verify successfully", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: true });

    const { sinkA, sinkB, unregister } = registerTwoTargets();

    try {
      const res = createMockServerResponse();
      const handled = await handleGoogleChatWebhookRequest(
        createWebhookRequest({
          authorization: "Bearer test-token",
          payload: { type: "ADDED_TO_SPACE", space: { name: "spaces/AAA" } },
        }),
        res,
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
      expect(sinkA).not.toHaveBeenCalled();
      expect(sinkB).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("routes to the single verified target when earlier targets fail verification", async () => {
    vi.mocked(verifyGoogleChatRequest)
      .mockResolvedValueOnce({ ok: false, reason: "invalid" })
      .mockResolvedValueOnce({ ok: true });

    const { sinkA, sinkB, unregister } = registerTwoTargets();

    try {
      const res = createMockServerResponse();
      const handled = await handleGoogleChatWebhookRequest(
        createWebhookRequest({
          authorization: "Bearer test-token",
          payload: { type: "ADDED_TO_SPACE", space: { name: "spaces/BBB" } },
        }),
        res,
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(sinkA).not.toHaveBeenCalled();
      expect(sinkB).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });

  it("rejects invalid bearer before attempting to read the body", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: false, reason: "invalid" });
    const { unregister } = registerTwoTargets();

    try {
      const req = createHeaderOnlyWebhookRequest({
        authorization: "Bearer invalid-token",
      });
      const onSpy = vi.spyOn(req, "on");
      const res = createMockServerResponse();
      const handled = await handleGoogleChatWebhookRequest(req, res);

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
      expect(onSpy).not.toHaveBeenCalledWith("data", expect.any(Function));
    } finally {
      unregister();
    }
  });

  it("supports add-on requests that provide systemIdToken in the body", async () => {
    vi.mocked(verifyGoogleChatRequest)
      .mockResolvedValueOnce({ ok: false, reason: "invalid" })
      .mockResolvedValueOnce({ ok: true });
    const { sinkA, sinkB, unregister } = registerTwoTargets();

    try {
      const res = createMockServerResponse();
      const handled = await handleGoogleChatWebhookRequest(
        createWebhookRequest({
          payload: {
            commonEventObject: { hostApp: "CHAT" },
            authorizationEventObject: { systemIdToken: "addon-token" },
            chat: {
              eventTime: "2026-03-02T00:00:00.000Z",
              user: { name: "users/12345", displayName: "Test User" },
              messagePayload: {
                space: { name: "spaces/AAA" },
                message: { text: "Hello from add-on" },
              },
            },
          },
        }),
        res,
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(sinkA).not.toHaveBeenCalled();
      expect(sinkB).toHaveBeenCalledTimes(1);
    } finally {
      unregister();
    }
  });
});
