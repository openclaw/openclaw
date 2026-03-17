import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../../src/plugins/registry.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { createMockServerResponse } from "../../../src/test-utils/mock-http-response.js";
import { verifyGoogleChatRequest } from "./auth.js";
import { handleGoogleChatWebhookRequest, registerGoogleChatWebhookTarget } from "./monitor.js";
vi.mock("./auth.js", () => ({
  verifyGoogleChatRequest: vi.fn()
}));
function createWebhookRequest(params) {
  const req = new EventEmitter();
  req.method = "POST";
  req.url = params.path ?? "/googlechat";
  req.headers = {
    authorization: params.authorization ?? "",
    "content-type": "application/json"
  };
  req.destroyed = false;
  req.socket = {
    remoteAddress: "127.0.0.1"
  };
  req.destroy = () => {
    req.destroyed = true;
    return req;
  };
  const originalOn = req.on.bind(req);
  let bodyScheduled = false;
  req.on = ((event, listener) => {
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
  });
  return req;
}
function createHeaderOnlyWebhookRequest(params) {
  const req = new EventEmitter();
  req.method = "POST";
  req.url = params.path ?? "/googlechat";
  req.headers = {
    authorization: params.authorization ?? "",
    "content-type": "application/json"
  };
  req.socket = {
    remoteAddress: "127.0.0.1"
  };
  return req;
}
const baseAccount = (accountId) => ({
  accountId,
  enabled: true,
  credentialSource: "none",
  config: {}
});
function registerTwoTargets() {
  const sinkA = vi.fn();
  const sinkB = vi.fn();
  const core = {};
  const config = {};
  const unregisterA = registerGoogleChatWebhookTarget({
    account: baseAccount("A"),
    config,
    runtime: {},
    core,
    path: "/googlechat",
    statusSink: sinkA,
    mediaMaxMb: 5
  });
  const unregisterB = registerGoogleChatWebhookTarget({
    account: baseAccount("B"),
    config,
    runtime: {},
    core,
    path: "/googlechat",
    statusSink: sinkB,
    mediaMaxMb: 5
  });
  return {
    sinkA,
    sinkB,
    unregister: () => {
      unregisterA();
      unregisterB();
    }
  };
}
async function dispatchWebhookRequest(req) {
  const res = createMockServerResponse();
  const handled = await handleGoogleChatWebhookRequest(req, res);
  expect(handled).toBe(true);
  return res;
}
async function expectVerifiedRoute(params) {
  const res = await dispatchWebhookRequest(params.request);
  expect(res.statusCode).toBe(params.expectedStatus);
  const expectedCounts = params.expectedSink === "A" ? [1, 0] : params.expectedSink === "B" ? [0, 1] : [0, 0];
  expect(params.sinkA).toHaveBeenCalledTimes(expectedCounts[0]);
  expect(params.sinkB).toHaveBeenCalledTimes(expectedCounts[1]);
}
function mockSecondVerifierSuccess() {
  vi.mocked(verifyGoogleChatRequest).mockResolvedValueOnce({ ok: false, reason: "invalid" }).mockResolvedValueOnce({ ok: true });
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
      config: {},
      runtime: {},
      core: {},
      path: "/googlechat",
      statusSink: vi.fn(),
      mediaMaxMb: 5
    });
    const unregisterB = registerGoogleChatWebhookTarget({
      account: baseAccount("B"),
      config: {},
      runtime: {},
      core: {},
      path: "/googlechat",
      statusSink: vi.fn(),
      mediaMaxMb: 5
    });
    expect(registry.httpRoutes).toHaveLength(1);
    expect(registry.httpRoutes[0]).toEqual(
      expect.objectContaining({
        pluginId: "googlechat",
        path: "/googlechat",
        source: "googlechat-webhook"
      })
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
      await expectVerifiedRoute({
        request: createWebhookRequest({
          authorization: "Bearer test-token",
          payload: { type: "ADDED_TO_SPACE", space: { name: "spaces/AAA" } }
        }),
        expectedStatus: 401,
        sinkA,
        sinkB,
        expectedSink: "none"
      });
    } finally {
      unregister();
    }
  });
  it("routes to the single verified target when earlier targets fail verification", async () => {
    mockSecondVerifierSuccess();
    const { sinkA, sinkB, unregister } = registerTwoTargets();
    try {
      await expectVerifiedRoute({
        request: createWebhookRequest({
          authorization: "Bearer test-token",
          payload: { type: "ADDED_TO_SPACE", space: { name: "spaces/BBB" } }
        }),
        expectedStatus: 200,
        sinkA,
        sinkB,
        expectedSink: "B"
      });
    } finally {
      unregister();
    }
  });
  it("rejects invalid bearer before attempting to read the body", async () => {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: false, reason: "invalid" });
    const { unregister } = registerTwoTargets();
    try {
      const req = createHeaderOnlyWebhookRequest({
        authorization: "Bearer invalid-token"
      });
      const onSpy = vi.spyOn(req, "on");
      const res = await dispatchWebhookRequest(req);
      expect(res.statusCode).toBe(401);
      expect(onSpy).not.toHaveBeenCalledWith("data", expect.any(Function));
    } finally {
      unregister();
    }
  });
  it("supports add-on requests that provide systemIdToken in the body", async () => {
    mockSecondVerifierSuccess();
    const { sinkA, sinkB, unregister } = registerTwoTargets();
    try {
      await expectVerifiedRoute({
        request: createWebhookRequest({
          payload: {
            commonEventObject: { hostApp: "CHAT" },
            authorizationEventObject: { systemIdToken: "addon-token" },
            chat: {
              eventTime: "2026-03-02T00:00:00.000Z",
              user: { name: "users/12345", displayName: "Test User" },
              messagePayload: {
                space: { name: "spaces/AAA" },
                message: { text: "Hello from add-on" }
              }
            }
          }
        }),
        expectedStatus: 200,
        sinkA,
        sinkB,
        expectedSink: "B"
      });
    } finally {
      unregister();
    }
  });
});
