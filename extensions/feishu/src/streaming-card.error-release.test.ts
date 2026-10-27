// Feishu streaming card tests exercise error-path response body cancellation
// through a real guarded HTTP transport against a loopback server.
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loopback = vi.hoisted(() => ({
  baseUrl: "",
  releases: [] as Array<{ bodyIsNull: boolean; bodyUsed: boolean }>,
  failedStage: "",
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

const handleRequest: Parameters<typeof withServer>[0] = (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const stage = url.pathname.includes("/auth/")
    ? "auth"
    : url.pathname.endsWith("/settings")
      ? "settings"
      : "create";
  const responses = {
    auth: { tenant_access_token: "token", expire: 3600 },
    settings: {},
    create: { data: { card_id: "card_1" } },
  };
  const errors = {
    auth: "tenant token rejected",
    settings: "settings rejected",
    create: "card create rejected",
  };
  const failed = stage === loopback.failedStage;
  res.writeHead(failed ? 500 : 200, { "content-type": "application/json" });
  res.end(
    JSON.stringify(failed ? { error: errors[stage] } : { code: 0, msg: "ok", ...responses[stage] }),
  );
};

beforeEach(() => {
  loopback.releases = [];
  loopback.failedStage = "";
});

describe("feishu streaming card error-path body release", () => {
  it.each([
    ["auth", "Token request", 1],
    ["create", "Create card request", 2],
    ["settings", "Close streaming card", 3],
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
      const session = new FeishuStreamingSession((stage === "settings" ? client : {}) as never, {
        appId: `app_error_${stage}`,
        appSecret: "secret",
      });
      if (stage === "settings") {
        await session.start("chat_id", "open_id");
      }
      loopback.failedStage = stage;
      await expect(
        stage === "settings" ? session.closeWithResult() : session.start("chat_id", "open_id"),
      ).rejects.toThrow(`${operation} failed with HTTP 500`);
      expect(loopback.releases).toEqual(
        Array.from({ length: releases }, () => ({ bodyIsNull: false, bodyUsed: true })),
      );
    });
  });
});
