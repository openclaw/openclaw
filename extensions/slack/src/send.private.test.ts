// Real send owner, Slack SDK and loopback HTTP transport; no live Slack account.
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessageSlack } from "./send.js";

const cfg = { channels: { slack: { botToken: "synthetic-private-fixture" } } };
const signInText = "Connect: https://example.test/authorize?state=private-fixture&scope=read";

beforeEach(() => {
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

describe("Slack sensitive private sends", () => {
  it.each(["success", "before-post", "later-chunk", "rate-limit"] as const)(
    "preserves private delivery and its authority through %s",
    async (scenario) => {
      let active = true;
      const posts: URLSearchParams[] = [];
      await withServer(
        (req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          req.on("end", () => {
            if (req.url !== "/api/chat.postMessage") {
              res.writeHead(404);
              res.end("unexpected route");
              return;
            }
            posts.push(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
            if (scenario === "later-chunk" || scenario === "rate-limit") {
              active = false;
            }
            if (scenario === "rate-limit") {
              res.writeHead(429, { "retry-after": "0" });
              res.end(JSON.stringify({ ok: false, error: "ratelimited" }));
            } else {
              res.end(JSON.stringify({ ok: true, channel: "D123", ts: "171234.567" }));
            }
          });
        },
        async (baseUrl) => {
          vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
          const delivery = sendMessageSlack(
            "user:U123",
            scenario === "later-chunk" ? `${signInText}\n${"private ".repeat(1100)}` : signInText,
            {
              cfg,
              textIsSlackPlainText: true,
              suppressLinkPreviews: true,
              onPlatformSendDispatch: async () => {
                if (scenario === "before-post") {
                  active = false;
                }
              },
              assertPlatformSendAuthorized: () => {
                if (!active) {
                  throw new Error("Run closed");
                }
              },
            },
          );
          if (scenario === "success") {
            await expect(delivery).resolves.toMatchObject({ messageId: "171234.567" });
          } else {
            await expect(delivery).rejects.toThrow("Run closed");
          }
        },
      );
      expect(posts).toHaveLength(scenario === "before-post" ? 0 : 1);
      if (posts[0]) {
        expect(posts[0].get("channel")).toBe("U123");
        expect(posts[0].get("text")).toContain(signInText);
        expect(posts[0].get("mrkdwn")).toBe("false");
        expect(posts[0].get("unfurl_links")).toBe("false");
        expect(posts[0].get("unfurl_media")).toBe("false");
        expect(posts[0].has("thread_ts")).toBe(false);
      }
    },
  );
});
