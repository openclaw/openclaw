import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ResolvedZaloAccount } from "./types.js";
import { handleZaloWebhookRequest, registerZaloWebhookTarget } from "./monitor.js";

type MockReq = EventEmitter & {
  method?: string;
  url?: string;
  headers: Record<string, string>;
  destroy: () => void;
};

type MockRes = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
  body: string;
};

function createMockReq(body: string): MockReq {
  const req = new EventEmitter() as MockReq;
  req.method = "POST";
  req.url = "/hook";
  req.headers = { "x-bot-api-secret-token": "secret" };
  req.destroy = () => {};
  queueMicrotask(() => {
    req.emit("data", Buffer.from(body, "utf8"));
    req.emit("end");
  });
  return req;
}

function createMockRes(): MockRes {
  return {
    statusCode: 200,
    body: "",
    setHeader: () => {},
    end(body?: string) {
      this.body = body ?? "";
    },
  };
}

describe("handleZaloWebhookRequest", () => {
  it("returns 400 for non-object payloads", async () => {
    const core = {} as PluginRuntime;
    const account: ResolvedZaloAccount = {
      accountId: "default",
      enabled: true,
      token: "tok",
      tokenSource: "config",
      config: {},
    };
    const unregister = registerZaloWebhookTarget({
      token: "tok",
      account,
      config: {} as OpenClawConfig,
      runtime: {},
      core,
      secret: "secret",
      path: "/hook",
      mediaMaxMb: 5,
    });

    try {
      const req = createMockReq("null");
      const res = createMockRes();
      const handled = await handleZaloWebhookRequest(
        req as unknown as Parameters<typeof handleZaloWebhookRequest>[0],
        res as unknown as Parameters<typeof handleZaloWebhookRequest>[1],
      );
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("invalid payload");
    } finally {
      unregister();
    }
  });
});
