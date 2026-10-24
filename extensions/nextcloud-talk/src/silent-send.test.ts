import { expect, it, vi } from "vitest";
import { nextcloudTalkPlugin } from "../channel-plugin-api.js";
import { withNextcloudTalkOutboundFixture as withTalk } from "./outbound-media.test-harness.js";
import type { CoreConfig } from "./types.js";

vi.mock("../runtime-api.js", async (original) => {
  const actual = await original<typeof import("../runtime-api.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...params,
        lookupFn: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
  };
});

it.each([true, false, undefined])("sends bot text with silent=%s", async (silent) => {
  await withTalk(async ({ ctx, requests }) => {
    const result = await nextcloudTalkPlugin.message!.send!.text!({ ...ctx, silent });
    expect(result).toMatchObject({ messageId: "900", receipt: { replyToId: "41" } });
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url.pathname).toBe("/cloud/ocs/v2.php/apps/spreed/api/v1/bot/allowed/message");
    expect(JSON.parse(request.body.toString())).toEqual({
      message: "The report",
      replyTo: "41",
      ...(silent ? { silent: true } : {}),
    });
  });
});

it.each(["", "https://example.com/report.pdf"])(
  "preserves quiet bot text fallback for media URL %j",
  async (mediaUrl) => {
    await withTalk(async ({ ctx, requests }) => {
      const cfg = structuredClone(ctx.cfg) as CoreConfig;
      const account = cfg.channels!["nextcloud-talk"]!.accounts!.work!;
      delete account.apiUser;
      delete account.apiPassword;
      await nextcloudTalkPlugin.message!.send!.media!({ ...ctx, cfg, mediaUrl, silent: true });
      expect(requests).toHaveLength(1);
      expect(JSON.parse(requests[0]!.body.toString())).toEqual({
        message: mediaUrl ? `The report\n\nAttachment: ${mediaUrl}` : "The report",
        replyTo: "41",
        silent: true,
      });
    });
  },
);

it.each(["The report", ""])("publishes a quiet native file with caption %j", async (text) => {
  await withTalk(async ({ ctx, requests, bytes }) => {
    const result = await nextcloudTalkPlugin.message!.send!.media!({ ...ctx, text, silent: true });
    const share = requests.find(({ url }) => url.pathname.endsWith("/shares"));
    const metadata = JSON.parse(new URLSearchParams(share?.body.toString()).get("talkMetaData")!);
    expect(metadata).toEqual({ caption: text, replyTo: 41, silent: true });
    expect(requests.find(({ method }) => method === "PUT")?.body).toEqual(bytes);
    expect(result).toMatchObject({ messageId: "42", receipt: { replyToId: "41" } });
    expect(requests.some(({ url }) => url.pathname.includes("/bot/"))).toBe(false);
  });
});

it.each([false, undefined])(
  "keeps ordinary native file sends unchanged with silent=%s",
  async (silent) => {
    await withTalk(async ({ ctx, requests }) => {
      await nextcloudTalkPlugin.message!.send!.media!({ ...ctx, silent });
      expect(requests.some(({ url }) => url.pathname.endsWith("/capabilities"))).toBe(false);
      const share = requests.find(({ url }) => url.pathname.endsWith("/shares"));
      expect(JSON.parse(new URLSearchParams(share?.body.toString()).get("talkMetaData")!)).toEqual({
        caption: "The report",
        replyTo: 41,
      });
    });
  },
);

it.each([
  { capabilities: { spreed: { features: ["silent-send", "silent-send-state"] } } },
  { capabilities: {} },
])("rejects unsupported quiet file publication before reading or uploading (%j)", async (data) => {
  await withTalk(async (fixture) => {
    fixture.respond = (request, response) => {
      if (!request.url.pathname.endsWith("/capabilities")) {
        return false;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ocs: { data } }));
      return true;
    };
    const mediaReadFile = vi.fn(async () => fixture.bytes);
    await expect(
      nextcloudTalkPlugin.message!.send!.media!({ ...fixture.ctx, silent: true, mediaReadFile }),
    ).rejects.toThrow(/silent.*media-caption/i);
    expect(mediaReadFile).not.toHaveBeenCalled();
    expect(fixture.requests.map(({ method }) => method)).toEqual(["GET"]);
  });
});

it("does not downgrade a quiet file send when capability lookup fails", async () => {
  await withTalk(async (fixture) => {
    fixture.respond = (request, response) => {
      if (!request.url.pathname.endsWith("/capabilities")) {
        return false;
      }
      response.writeHead(503);
      response.end();
      return true;
    };
    await expect(
      nextcloudTalkPlugin.message!.send!.media!({ ...fixture.ctx, silent: true }),
    ).rejects.toThrow(/503/);
    expect(fixture.requests.map(({ method }) => method)).toEqual(["GET"]);
  });
});

it.each(["cancel", "revoke"])(
  "stops a quiet file send after capability lookup (%s)",
  async (mode) => {
    await withTalk(async (fixture) => {
      const controller = new AbortController();
      let current = true;
      fixture.respond = (request) => {
        if (request.url.pathname.endsWith("/capabilities")) {
          if (mode === "cancel") {
            controller.abort(new Error("quiet send cancelled"));
          }
          current = false;
        }
        return false;
      };
      await expect(
        nextcloudTalkPlugin.message!.send!.media!({
          ...fixture.ctx,
          silent: true,
          signal: controller.signal,
          assertDirectAdapterHandoff: () => {
            if (!current) {
              throw new Error("quiet send custody revoked");
            }
          },
        }),
      ).rejects.toThrow();
      expect(fixture.requests.map(({ method }) => method)).toEqual(["GET"]);
    });
  },
);
