// Feishu streaming card tests exercise error-path response body cancellation
// through a real guarded HTTP transport against a loopback server.
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loopback = vi.hoisted(() => ({
  baseUrl: "",
  releases: [] as Array<{ bodyIsNull: boolean; bodyUsed: boolean }>,
  authStatus: 200,
  createStatus: 200,
  settingsStatus: 200,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (...args: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      const [params] = args;
      const url = new URL(params.url);
      const redirected = new URL(`${url.pathname}${url.search}`, loopback.baseUrl).toString();
      const guarded = await actual.fetchWithSsrFGuard({
        ...params,
        policy: { allowPrivateNetwork: true },
        url: redirected,
      });
      return {
        ...guarded,
        release: async () => {
          loopback.releases.push({
            bodyIsNull: guarded.response.body === null,
            bodyUsed: guarded.response.bodyUsed,
          });
          await guarded.release();
        },
      };
    },
  };
});

const { FeishuStreamingSession } = await import("./streaming-card.js");

function writeJson(res: import("node:http").ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const handleRequest: Parameters<typeof withServer>[0] = (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const [status, payload, error] = url.pathname.includes("/auth/")
    ? ([
        loopback.authStatus,
        { code: 0, msg: "ok", tenant_access_token: "token", expire: 3600 },
        "tenant token rejected",
      ] as const)
    : url.pathname.endsWith("/settings")
      ? ([loopback.settingsStatus, { code: 0, msg: "ok" }, "settings rejected"] as const)
      : ([
          loopback.createStatus,
          { code: 0, msg: "ok", data: { card_id: "card_1" } },
          "card create rejected",
        ] as const);
  writeJson(res, status === 200 ? payload : { error }, status);
};

beforeEach(() => {
  loopback.releases = [];
  loopback.authStatus = 200;
  loopback.createStatus = 200;
  loopback.settingsStatus = 200;
});

describe("feishu streaming card error-path body release", () => {
  it.each([
    ["authStatus", "Token request", 1],
    ["createStatus", "Create card request", 2],
    ["settingsStatus", "Close streaming card", 3],
  ] as const)("cancels unread %s error body before release", async (stage, operation, releases) => {
    await withServer(handleRequest, async (baseUrl) => {
      loopback.baseUrl = baseUrl;
      const client = {
        im: {
          message: {
            create: async () => ({ code: 0, data: { message_id: "msg_1" } }),
          },
        },
      };
      const session = new FeishuStreamingSession(
        (stage === "settingsStatus" ? client : {}) as never,
        {
          appId: `app_error_${stage}`,
          appSecret: "secret",
        },
      );
      if (stage === "settingsStatus") {
        await session.start("chat_id", "open_id");
      }
      loopback[stage] = 500;
      await expect(
        stage === "settingsStatus"
          ? session.closeWithResult()
          : session.start("chat_id", "open_id"),
      ).rejects.toThrow(`${operation} failed with HTTP 500`);
      expect(loopback.releases).toEqual(
        Array.from({ length: releases }, () => ({ bodyIsNull: false, bodyUsed: true })),
      );
    });
  });
});
