import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import type { ClawdbotConfig, PluginRuntime } from "clawdbot/plugin-sdk";
import type { ResolvedZaloAccount } from "./types.js";
import { handleZaloWebhookRequest, registerZaloWebhookTarget } from "./monitor.js";

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
      config: {} as ClawdbotConfig,
      runtime: {},
      core,
      secret: "secret",
      path: "/hook",
      mediaMaxMb: 5,
    });

    try {
      const req = Readable.from(["null"]) as unknown as Parameters<
        typeof handleZaloWebhookRequest
      >[0];
      Object.assign(req, {
        method: "POST",
        url: "/hook",
        headers: {
          "x-bot-api-secret-token": "secret",
        },
      });

      const res = {
        statusCode: 0,
        setHeader: () => {},
        end: () => {},
      } as Parameters<typeof handleZaloWebhookRequest>[1];

      const handled = await handleZaloWebhookRequest(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
    } finally {
      unregister();
    }
  });
});
