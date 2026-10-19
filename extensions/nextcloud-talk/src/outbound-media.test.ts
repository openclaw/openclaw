import type { ChannelMessageSendMediaContext } from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nextcloudTalkPlugin } from "../channel-plugin-api.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { withNextcloudTalkOutboundFixture as withTalk } from "./outbound-media.test-harness.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";

const transport = vi.hoisted(() => ({
  beforeLookup: undefined as ((url: string) => Promise<void> | void) | undefined,
}));
vi.mock("../runtime-api.js", async (original) => {
  const actual = await original<typeof import("../runtime-api.js")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...params,
        lookupFn: async () => {
          await transport.beforeLookup?.(params.url);
          return [{ address: "127.0.0.1", family: 4 }];
        },
      }),
  };
});

let clock = 1_800_000_000_000;
beforeEach(() => {
  clock += 60_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => {
  transport.beforeLookup = undefined;
  vi.restoreAllMocks();
});

const send = (ctx: ChannelMessageSendMediaContext) =>
  nextcloudTalkPlugin.message!.send!.media!(ctx);

function botOnlyConfig(ctx: ChannelMessageSendMediaContext) {
  const cfg = structuredClone(ctx.cfg) as CoreConfig;
  const account = cfg.channels?.["nextcloud-talk"]?.accounts?.work;
  if (!account) {
    throw new Error("expected work fixture account");
  }
  delete account.apiUser;
  delete account.apiPassword;
  delete account.apiPasswordFile;
  return cfg;
}

it.each(["The report", ""])("delivers a real file share with caption %j", async (text) => {
  await withTalk(async ({ ctx, requests, bytes }) => {
    const result = await send({ ...ctx, text });
    const upload = requests.find(({ method }) => method === "PUT");
    expect(upload?.body).toEqual(bytes);
    expect(upload?.url.pathname).toMatch(/^\/cloud\/remote.php\/dav\/files\/canonical-user\//);
    expect(
      requests.every(
        ({ authorization }) =>
          authorization ===
          `Basic ${Buffer.from("login-alias:synthetic-app-password").toString("base64")}`,
      ),
    ).toBe(true);
    const shareRequest = requests.find(({ url }) => url.pathname.endsWith("/shares"));
    const share = new URLSearchParams(shareRequest?.body.toString());
    expect(share.get("shareType")).toBe("10");
    expect(share.get("shareWith")).toBe("allowed");
    expect(JSON.parse(share.get("talkMetaData") ?? "{}")).toEqual({ caption: text, replyTo: 41 });
    expect(share.get("permissions")).toBe("1");
    expect(requests.some(({ url }) => url.pathname.includes("/bot/"))).toBe(false);
    expect(result).toMatchObject({
      messageId: "42",
      receipt: { platformMessageIds: ["42"], replyToId: "41" },
    });
    const history = requests.find(({ url }) => url.pathname.includes("/chat/"))!.url;
    expect(history.searchParams.get("setReadMarker")).toBe("0");
    expect(history.searchParams.get("noStatusUpdate")).toBe("1");
    expect(history.searchParams.get("markNotificationsAsRead")).toBe("0");
  });
});

it("requires API credentials before reading or uploading the attachment", async () => {
  await withTalk(async ({ ctx, requests }) => {
    const cfg = {
      channels: {
        "nextcloud-talk": { baseUrl: "https://cloud.invalid", botSecret: "synthetic-bot-secret" },
      },
    };
    const mediaReadFile = vi.fn(async () => Buffer.from("not read"));
    await expect(send({ ...ctx, cfg, accountId: undefined, mediaReadFile })).rejects.toThrow(
      /apiUser.*apiPassword/,
    );
    expect(mediaReadFile).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });
});

it.each(["The report", ""])(
  "preserves bot-only web attachment links with caption %j",
  async (text) => {
    await withTalk(async ({ ctx, requests }) => {
      const mediaUrl = "https://example.com/report.pdf?download=1";
      const mediaReadFile = vi.fn(async () => {
        throw new Error("must not read link bytes");
      });
      const result = await send({ ...ctx, cfg: botOnlyConfig(ctx), text, mediaUrl, mediaReadFile });
      expect(result).toMatchObject({
        messageId: "900",
        receipt: { platformMessageIds: ["900"], replyToId: "41" },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url.pathname).toBe(
        "/cloud/ocs/v2.php/apps/spreed/api/v1/bot/allowed/message",
      );
      expect(JSON.parse(requests[0]!.body.toString())).toEqual({
        message: `${text}\n\nAttachment: ${mediaUrl}`.trim(),
        replyTo: "41",
      });
      expect(requests[0]?.authorization).toBeUndefined();
      expect(mediaReadFile).not.toHaveBeenCalled();
    });
  },
);

it.each([
  "/private/report.pdf",
  "file:///private/report.pdf",
  "report.pdf",
  "data:text/plain,private",
  "https://user:password@example.com/report.pdf",
])("does not expose a non-web bot-only attachment %s", async (mediaUrl) => {
  await withTalk(async ({ ctx, requests }) => {
    await expect(send({ ...ctx, cfg: botOnlyConfig(ctx), mediaUrl })).rejects.toThrow(
      /apiUser.*apiPassword/u,
    );
    expect(requests).toEqual([]);
  });
});

it.each([
  { apiUser: "configured-user" },
  { apiPassword: "configured-password" },
  { apiUser: "configured-user", apiPasswordFile: "/missing/synthetic-app-password" },
])(
  "does not silently fall back for incomplete or unavailable API configuration %j",
  async (apiConfig) => {
    await withTalk(async ({ ctx, requests }) => {
      const cfg = botOnlyConfig(ctx);
      Object.assign(cfg.channels!["nextcloud-talk"]!.accounts!.work!, apiConfig);
      await expect(
        send({ ...ctx, cfg, mediaUrl: "https://example.com/report.pdf" }),
      ).rejects.toThrow(/apiUser.*apiPassword/u);
      expect(requests).toEqual([]);
    });
  },
);

it("cancels a bot-only URL send after dispatch admission but before HTTP", async () => {
  await withTalk(async ({ ctx, requests }) => {
    const controller = new AbortController();
    await expect(
      send({
        ...ctx,
        cfg: botOnlyConfig(ctx),
        mediaUrl: "https://example.com/report.pdf",
        signal: controller.signal,
        onPlatformSendDispatch: async () => {
          controller.abort(new Error("URL send stopped"));
        },
      }),
    ).rejects.toThrow("URL send stopped");
    expect(requests).toEqual([]);
  });
});

it("does not upload files outside the approved media roots", async () => {
  await withTalk(async ({ ctx, requests }) => {
    await expect(send({ ...ctx, mediaLocalRoots: [] })).rejects.toThrow();
    expect(requests.some(({ method }) => method === "PUT" || method === "MKCOL")).toBe(false);
  });
});

it("cleans an unshared upload when custody is revoked before publication", async () => {
  await withTalk(async ({ ctx, requests }) => {
    let current = true;
    transport.beforeLookup = (url) => {
      if (url.includes("/files_sharing/")) {
        current = false;
      }
    };
    await expect(
      send({
        ...ctx,
        onPlatformSendDispatch: async () => {},
        assertDirectAdapterHandoff: () => {
          if (!current) {
            throw new Error("custody revoked");
          }
        },
      }),
    ).rejects.toThrow("custody revoked");
    expect(requests.some(({ method }) => method === "PUT")).toBe(true);
    expect(requests.some(({ method }) => method === "DELETE")).toBe(true);
    expect(requests.some(({ url }) => url.pathname.endsWith("/shares"))).toBe(false);
  });
});

it("never follows an authenticated redirect", async () => {
  await withTalk(async (fixture) => {
    fixture.respond = (_, response) => {
      response.writeHead(302, { location: "/credential-leak" });
      response.end();
      return true;
    };
    await expect(send(fixture.ctx)).rejects.toThrow();
    expect(fixture.requests).toHaveLength(1);
  });
});

it.each([
  { status: 401, recovery: /apiUser.*app password.*before retrying/u },
  { status: 507, recovery: /Files storage.*quota.*before retrying/u },
  { status: 403, recovery: /Nextcloud server logs.*write access/u },
  { status: 500, recovery: /Nextcloud server logs.*write access/u },
])(
  "explains recovery without sharing after a rejected upload ($status)",
  async ({ status, recovery }) => {
    await withTalk(async (fixture) => {
      fixture.respond = (request, response) => {
        if (request.method !== "PUT") {
          return false;
        }
        response.writeHead(status);
        response.end("private server diagnostics must not reach the error message");
        return true;
      };
      const error = await send(fixture.ctx).then(
        () => {
          throw new Error("rejected upload unexpectedly succeeded");
        },
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`upload failed (${status})`);
      expect((error as Error).message).toMatch(recovery);
      expect((error as Error).message).not.toContain("private server diagnostics");
      expect(fixture.requests.some(({ url }) => url.pathname.endsWith("/shares"))).toBe(false);
      expect(fixture.requests.filter(({ method }) => method === "DELETE")).toHaveLength(1);
    });
  },
);

it("preserves the upload and reports uncertainty when no chat receipt is available", async () => {
  await withTalk(async (fixture) => {
    fixture.respond = (request, response) => {
      if (!request.url.pathname.includes("/chat/")) {
        return false;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ocs: { data: [] } }));
      return true;
    };
    await expect(send(fixture.ctx)).rejects.toThrow(/not confirmed|unknown/i);
    expect(fixture.requests.filter(({ url }) => url.pathname.endsWith("/shares"))).toHaveLength(1);
    expect(fixture.requests.some(({ method }) => method === "DELETE")).toBe(false);
  });
});

it.each([403, 500, "lost-ack"] as const)(
  "reconciles a published share despite %s without retrying",
  async (status) => {
    await withTalk(async (fixture) => {
      let referenceId = "";
      fixture.respond = (request, response) => {
        if (request.url.pathname.endsWith("/shares")) {
          referenceId = new URLSearchParams(request.body.toString()).get("referenceId") ?? "";
          if (status === "lost-ack") {
            response.destroy();
          } else {
            response.writeHead(status);
            response.end();
          }
          return true;
        }
        if (request.url.pathname.includes("/chat/")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              ocs: {
                data: [
                  {
                    id: 42,
                    token: "allowed",
                    actorType: "users",
                    actorId: "canonical-user",
                    referenceId,
                    messageParameters: { file: { id: "81" } },
                  },
                ],
              },
            }),
          );
          return true;
        }
        return false;
      };
      await expect(send(fixture.ctx)).resolves.toMatchObject({ messageId: "42" });
      expect(fixture.requests.filter(({ url }) => url.pathname.endsWith("/shares"))).toHaveLength(
        1,
      );
      expect(fixture.requests.some(({ method }) => method === "DELETE")).toBe(false);
    });
  },
);

it("rejects oversize attachments before writing Nextcloud storage", async () => {
  await withTalk(async ({ ctx, requests }) => {
    const cfg = structuredClone(ctx.cfg) as CoreConfig;
    cfg.channels!["nextcloud-talk"]!.accounts!.work!.mediaMaxMb = 0.000001;
    await expect(send({ ...ctx, cfg })).rejects.toThrow();
    expect(requests).toEqual([]);
  });
});

it("recognizes exact own echoes before acknowledgment and after the cache expires", async () => {
  await withTalk(async (fixture) => {
    const { isNextcloudTalkOutboundFileEcho } = await import("./outbound-media.js");
    const account = resolveNextcloudTalkAccount({
      cfg: fixture.ctx.cfg as CoreConfig,
      accountId: "work",
    });
    let echo: NextcloudTalkInboundMessage;
    let earlyEcho: Promise<boolean> | undefined;
    fixture.respond = (request) => {
      if (!request.url.pathname.endsWith("/shares")) {
        return false;
      }
      const filePath = new URLSearchParams(request.body.toString()).get("path")!;
      echo = {
        messageId: "42",
        roomToken: "allowed",
        roomName: "Fixture",
        senderId: "users/canonical-user",
        senderName: "API",
        text: "The report",
        mediaType: "text/plain",
        timestamp: clock,
        isGroupChat: true,
        attachment: {
          fileId: "81",
          name: filePath.split("/").at(-1)!,
          mimeType: "application/pdf",
          declaredSizeBytes: fixture.bytes.length,
          shareUrl: "https://cloud.invalid/s/synthetic",
          hideDownload: false,
        },
      };
      earlyEcho = isNextcloudTalkOutboundFileEcho({ account, message: echo });
      return false;
    };
    await send(fixture.ctx);
    expect(await earlyEcho).toBe(true);
    const controller = new AbortController();
    controller.abort(new Error("echo lookup cancelled"));
    await expect(
      isNextcloudTalkOutboundFileEcho({ account, message: echo!, signal: controller.signal }),
    ).rejects.toThrow("echo lookup cancelled");
    const before = fixture.requests.length;
    clock += 31_000;
    await expect(isNextcloudTalkOutboundFileEcho({ account, message: echo! })).resolves.toBe(true);
    expect(fixture.requests.slice(before).map(({ url }) => url.pathname)).toEqual([
      "/cloud/ocs/v1.php/cloud/user",
      "/cloud/ocs/v2.php/apps/spreed/api/v1/chat/allowed",
    ]);
    await expect(
      isNextcloudTalkOutboundFileEcho({
        account,
        message: { ...echo!, senderId: "users/another-user" },
      }),
    ).resolves.toBe(false);
    await expect(
      isNextcloudTalkOutboundFileEcho({ account, message: { ...echo!, roomToken: "other-room" } }),
    ).resolves.toBe(false);
    await expect(
      isNextcloudTalkOutboundFileEcho({
        account,
        message: { ...echo!, attachment: { ...echo!.attachment!, fileId: "82" } },
      }),
    ).resolves.toBe(false);
    fixture.respond = (request, response) => {
      if (!request.url.pathname.includes("/chat/")) {
        return false;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ocs: {
            data: [
              {
                id: 42,
                token: "allowed",
                actorType: "users",
                actorId: "canonical-user",
                referenceId: "unrelated-user-post",
                messageParameters: { file: { id: "81" } },
              },
            ],
          },
        }),
      );
      return true;
    };
    await expect(isNextcloudTalkOutboundFileEcho({ account, message: echo! })).resolves.toBe(false);
  });
});
