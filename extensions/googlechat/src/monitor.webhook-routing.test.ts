import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { verifyGoogleChatRequest } from "./auth.js";
import { registerGoogleChatWebhookTarget } from "./monitor-routing.js";

// mock-isolation: routing cases supply verification outcomes without live Google credentials.
vi.mock("./auth.js", () => ({ verifyGoogleChatRequest: vi.fn() }));

function request(authorization = "", payload?: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = "POST";
  req.url = "/googlechat";
  req.headers = { authorization, "content-type": "application/json" };
  Object.assign(req, { socket: { remoteAddress: "127.0.0.1" } });
  if (payload === undefined) {
    return req;
  }
  req.destroyed = false;
  req.destroy = () => {
    req.destroyed = true;
    return req;
  };
  const on = req.on.bind(req);
  let scheduled = false;
  req.on = ((event: string, listener: (...args: unknown[]) => void) => {
    const result = on(event, listener);
    if (!scheduled && event === "data") {
      scheduled = true;
      void Promise.resolve().then(() => {
        req.emit("data", Buffer.from(JSON.stringify(payload), "utf-8"));
        if (!req.destroyed) {
          req.emit("end");
        }
      });
    }
    return result;
  }) as IncomingMessage["on"];
  return req;
}

function target(accountId: string) {
  return {
    account: {
      accountId,
      enabled: true,
      credentialSource: "none",
      config: {},
    } as ResolvedGoogleChatAccount,
    config: {},
    runtime: { log: vi.fn() },
    core: {} as PluginRuntime,
    path: "/googlechat",
    statusSink: vi.fn(),
    mediaMaxMb: 5,
    ingress: { receive: vi.fn(async () => ({ kind: "ignored" as const })) },
  };
}

const unregister: Array<() => void> = [];
let registry = createEmptyPluginRegistry();

function registerTwoTargets() {
  registry = createEmptyPluginRegistry();
  setActivePluginRegistry(registry);
  return ["A", "B"].map((id) => {
    const entry = target(id);
    unregister.push(registerGoogleChatWebhookTarget(entry));
    return entry;
  });
}

async function dispatch(req: IncomingMessage) {
  const res = createMockServerResponse();
  await expectDefined(registry.httpRoutes[0], "Google Chat webhook route").handler(req, res);
  return res;
}

afterEach(() => {
  for (const stop of unregister.splice(0)) {
    stop();
  }
  setActivePluginRegistry(createEmptyPluginRegistry());
});
afterAll(() => {
  vi.doUnmock("./auth.js");
  vi.resetModules();
});

it("rejects a foreign route collision instead of storing an unreachable target", () => {
  registry = createEmptyPluginRegistry();
  const existingRoute = {
    path: "/googlechat",
    match: "exact" as const,
    auth: "plugin" as const,
    handler: () => {},
    pluginId: "other-plugin",
    source: "other-webhook",
  };
  registry.httpRoutes.push(existingRoute);
  setActivePluginRegistry(registry);
  expect(() => registerGoogleChatWebhookTarget(target("A"))).toThrow("route replacement denied");
  expect(registry.httpRoutes).toEqual([existingRoute]);
});

it.each([
  { name: "rejects ambiguous verified targets", ambiguous: true, addon: false },
  { name: "routes past a failed verifier", ambiguous: false, addon: false },
  { name: "routes add-on systemIdToken requests", ambiguous: false, addon: true },
])("$name", async ({ ambiguous, addon }) => {
  if (ambiguous) {
    vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: true });
  } else {
    vi.mocked(verifyGoogleChatRequest)
      .mockResolvedValueOnce({ ok: false, reason: "invalid" })
      .mockResolvedValueOnce({ ok: true });
  }
  const targets = registerTwoTargets();
  const payload = addon
    ? {
        commonEventObject: { hostApp: "CHAT" },
        authorizationEventObject: { systemIdToken: "addon-token" },
        chat: {
          messagePayload: {
            space: { name: "spaces/AAA" },
            message: { name: "spaces/AAA/messages/add-on-1", text: "Hello from add-on" },
          },
        },
      }
    : { type: "ADDED_TO_SPACE", space: { name: "spaces/AAA" } };
  expect((await dispatch(request(addon ? "" : "Bearer test-token", payload))).statusCode).toBe(
    ambiguous ? 401 : 200,
  );
  expect(targets.map((entry) => entry.statusSink.mock.calls.length)).toEqual(
    ambiguous ? [0, 0] : [0, 1],
  );
  expect(targets.map((entry) => entry.runtime.log.mock.calls)).toEqual([[], []]);
});

it("rejects invalid bearer before attempting to read the body", async () => {
  vi.mocked(verifyGoogleChatRequest).mockResolvedValue({ ok: false, reason: "invalid" });
  registerTwoTargets();
  const req = request("Bearer invalid-token");
  const on = vi.spyOn(req, "on");
  expect((await dispatch(req)).statusCode).toBe(401);
  expect(on.mock.calls.map(([event]) => event)).not.toContain("data");
});
