import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { handleSlackHttpRequest } from "../http/index.js";
import { monitorSlackProvider } from "./provider.js";

const boltFakes = vi.hoisted(() => {
  const httpReceiverArgs: Array<Record<string, unknown>> = [];

  class FakeHTTPReceiver {
    constructor(readonly args: Record<string, unknown>) {
      httpReceiverArgs.push(args);
    }
  }

  class FakeSocketModeReceiver {
    constructor(readonly args: Record<string, unknown>) {}
  }

  class FakeApp {
    client = {
      auth: {
        test: vi.fn().mockResolvedValue({
          user_id: "UBOT",
          bot_id: "BBOT",
          team_id: "T123",
          api_app_id: "A123",
        }),
      },
      chat: {
        postEphemeral: vi.fn(),
      },
    };
    processEvent = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);

    constructor(readonly args: Record<string, unknown>) {
      apps.push(this);
    }

    use() {
      return this;
    }

    event() {
      return this;
    }

    command() {
      return this;
    }

    action() {
      return this;
    }

    view() {
      return this;
    }
  }

  const apps: FakeApp[] = [];

  return {
    FakeApp,
    FakeHTTPReceiver,
    FakeSocketModeReceiver,
    httpReceiverArgs,
    apps,
  };
});

vi.mock("@slack/bolt", () => ({
  App: boltFakes.FakeApp,
  HTTPReceiver: boltFakes.FakeHTTPReceiver,
  SocketModeReceiver: boltFakes.FakeSocketModeReceiver,
  default: {
    App: boltFakes.FakeApp,
    HTTPReceiver: boltFakes.FakeHTTPReceiver,
    SocketModeReceiver: boltFakes.FakeSocketModeReceiver,
  },
}));

function createRequest(params: {
  path?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): IncomingMessage {
  const rawBody = params.body === undefined ? "" : JSON.stringify(params.body);
  const req = Readable.from([rawBody]) as IncomingMessage;
  req.method = "POST";
  req.url = params.path ?? "/slack/events";
  req.headers = {};
  for (const [key, value] of Object.entries(params.headers ?? {})) {
    req.headers[key.toLowerCase()] = value;
  }
  return req;
}

function createResponse(): ServerResponse & { body: string; headers: Record<string, string> } {
  const res = {
    statusCode: 200,
    body: "",
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(chunk?: string) {
      if (chunk !== undefined) {
        this.body += chunk;
      }
      return this;
    },
  };
  return res as ServerResponse & { body: string; headers: Record<string, string> };
}

async function waitForTrustedRoute(): Promise<
  ServerResponse & { body: string; headers: Record<string, string> }
> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const res = createResponse();
    const handled = await handleSlackHttpRequest(
      createRequest({
        body: {
          type: "events_api",
          payload: {
            event_time: Math.floor(Date.now() / 1000),
            event: { type: "app_mention", user: "U123", text: "hi" },
          },
        },
        headers: {
          "X-OpenClaw-Trusted-Upstream-Verified": "true",
          "Content-Type": "application/json",
        },
      }),
      res,
    );
    if (handled) {
      return res;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error("trusted-upstream Slack route was not registered");
}

function createTrustedUpstreamConfig(slackOverrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    channels: {
      slack: {
        enabled: true,
        mode: "trusted-upstream",
        botToken: "xoxb-placeholder-proxied",
        slackApiUrl: "http://slack-proxy.internal:8080/slack/api/",
        webhookPath: "/slack/events",
        trustedUpstream: {
          requireHeader: { name: "X-OpenClaw-Trusted-Upstream-Verified", value: "true" },
          maxEventAge: 300,
        },
        dmPolicy: "allowlist",
        allowFrom: ["U123"],
        groupPolicy: "allowlist",
        channels: {},
        ...slackOverrides,
      },
    },
  } as unknown as OpenClawConfig;
}

describe("trusted-upstream Slack monitor registration", () => {
  it("registers slackWebhookPath with trusted-upstream mode and bot token only", async () => {
    const abortController = new AbortController();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
    const config = {
      channels: {
        slack: {
          enabled: true,
          mode: "trusted-upstream",
          botToken: "xoxb-placeholder-proxied",
          slackApiUrl: "http://slack-proxy.internal:8080/slack/api/",
          webhookPath: "/slack/events",
          trustedUpstream: {
            requireHeader: {
              name: "X-OpenClaw-Trusted-Upstream-Verified",
              value: "true",
            },
            maxEventAge: 300,
          },
          dmPolicy: "allowlist",
          allowFrom: ["U123"],
          groupPolicy: "allowlist",
          channels: {},
        },
      },
    } as unknown as OpenClawConfig;

    const monitorPromise = monitorSlackProvider({
      config,
      runtime,
      abortSignal: abortController.signal,
    });

    try {
      const res = await waitForTrustedRoute();

      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("");
      expect(runtime.log).toHaveBeenCalledWith(
        "slack trusted-upstream mode listening at /slack/events",
      );
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });

  it("disables Bolt signature verification in trusted-upstream mode (no signing secret required)", async () => {
    boltFakes.httpReceiverArgs.length = 0;
    const abortController = new AbortController();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    // Note: no `signingSecret` is configured here. Bolt's HTTPReceiver throws at
    // construction when signature verification is on and the secret is empty, so
    // this also covers the zero-credential startup path.
    const config = createTrustedUpstreamConfig();

    const monitorPromise = monitorSlackProvider({
      config,
      runtime,
      abortSignal: abortController.signal,
    });

    try {
      await waitForTrustedRoute();

      expect(boltFakes.httpReceiverArgs.length).toBeGreaterThan(0);
      const receiverArgs = boltFakes.httpReceiverArgs.at(-1);
      expect(receiverArgs?.signatureVerification).toBe(false);
      expect(receiverArgs?.signingSecret).toBe("");
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });

  it("uses configured trustedUpstream bot identity and skips auth.test", async () => {
    boltFakes.apps.length = 0;
    const abortController = new AbortController();
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const config = createTrustedUpstreamConfig({
      trustedUpstream: {
        requireHeader: { name: "X-OpenClaw-Trusted-Upstream-Verified", value: "true" },
        maxEventAge: 300,
        botUserId: "U999BOT",
        botId: "B999BOT",
      },
    });

    const monitorPromise = monitorSlackProvider({
      config,
      runtime,
      abortSignal: abortController.signal,
    });

    try {
      await waitForTrustedRoute();

      const app = boltFakes.apps.at(-1);
      // With a configured trusted identity the placeholder-token auth.test is
      // skipped entirely; the configured identity feeds the monitor context.
      expect(app?.client.auth.test).not.toHaveBeenCalled();

      const warnedMentionDisabled = runtime.log.mock.calls.some(
        ([message]) =>
          typeof message === "string" &&
          message.includes("explicit bot-mention detection will be disabled"),
      );
      expect(warnedMentionDisabled).toBe(false);
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });
});
