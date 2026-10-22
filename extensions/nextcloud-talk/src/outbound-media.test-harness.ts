import { writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { ChannelMessageSendMediaContext } from "openclaw/plugin-sdk/channel-outbound";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import type { NextcloudTalkInboundMessage } from "./types.js";

export function fileMessage(
  fixture: NextcloudTalkOutboundFixture,
  overrides: Partial<NextcloudTalkInboundMessage> = {},
): NextcloudTalkInboundMessage {
  return {
    messageId: "42",
    roomToken: "allowed",
    roomName: "Fixture",
    senderId: "users/canonical-user",
    senderName: "API",
    text: "The report",
    mediaType: "text/plain",
    timestamp: Date.now(),
    isGroupChat: true,
    attachment: {
      fileId: "81",
      name: "openclaw-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-report.pdf",
      mimeType: "application/pdf",
      declaredSizeBytes: fixture.bytes.length,
      shareUrl: "https://cloud.invalid/s/synthetic",
      hideDownload: false,
    },
    ...overrides,
  };
}

export function chatFile(referenceId: string) {
  return {
    id: 42,
    token: "allowed",
    actorType: "users",
    actorId: "canonical-user",
    referenceId,
    messageParameters: { file: { id: "81" } },
  };
}

export function respondOcs(response: ServerResponse, data: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ ocs: { data } }));
}

type NextcloudTalkOutboundRequest = {
  method: string;
  url: URL;
  body: Buffer;
  authorization?: string;
  ifNoneMatch?: string;
  headers: IncomingMessage["headers"];
};
export type NextcloudTalkOutboundFixture = {
  directory: string;
  requests: NextcloudTalkOutboundRequest[];
  ctx: Omit<ChannelMessageSendMediaContext, "onDeliveryResult">;
  bytes: Buffer;
  respond?: (request: NextcloudTalkOutboundRequest, response: ServerResponse) => boolean;
};

export async function withNextcloudTalkOutboundFixture(
  run: (fixture: NextcloudTalkOutboundFixture) => Promise<void>,
) {
  await withTempDir("nextcloud-outbound-", async (directory) => {
    const bytes = Buffer.from("%PDF-1.4\nsynthetic attachment\n%%EOF\n");
    const mediaUrl = path.join(directory, "report.pdf");
    await writeFile(mediaUrl, bytes);
    const fixture: NextcloudTalkOutboundFixture = {
      directory,
      requests: [],
      bytes,
      ctx: {
        cfg: {},
        to: "room:allowed",
        text: "The report",
        mediaUrl,
        mediaLocalRoots: [directory],
        accountId: "work",
        replyToId: "41",
      },
    };
    let uploadedPath = "";
    let referenceId = "";
    const respond = async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const recorded: NextcloudTalkOutboundRequest = {
        method: request.method ?? "GET",
        url: new URL(request.url ?? "/", "http://fixture.invalid"),
        body: Buffer.concat(chunks),
        authorization: request.headers.authorization,
        headers: request.headers,
        ifNoneMatch:
          typeof request.headers["if-none-match"] === "string"
            ? request.headers["if-none-match"]
            : undefined,
      };
      fixture.requests.push(recorded);
      if (fixture.respond?.(recorded, response)) {
        return;
      }
      let data: unknown;
      if (recorded.url.pathname === "/cloud/ocs/v1.php/cloud/user") {
        data = { id: "canonical-user" };
      } else if (recorded.method === "MKCOL") {
        response.writeHead(201);
        response.end();
        return;
      } else if (recorded.method === "PUT") {
        uploadedPath = decodeURIComponent(recorded.url.pathname).replace(
          "/cloud/remote.php/dav/files/canonical-user",
          "",
        );
        response.writeHead(201, { "oc-fileid": "81" });
        response.end();
        return;
      } else if (recorded.method === "PROPFIND") {
        response.writeHead(207, { "content-type": "application/xml" });
        response.end(
          '<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response><d:propstat><d:prop><oc:fileid>81</oc:fileid></d:prop></d:propstat></d:response></d:multistatus>',
        );
        return;
      } else if (recorded.url.pathname === "/cloud/ocs/v2.php/apps/files_sharing/api/v1/shares") {
        const share = new URLSearchParams(recorded.body.toString());
        referenceId = share.get("referenceId") ?? "";
        data = { id: "700", file_source: 81 };
      } else if (recorded.url.pathname === "/cloud/ocs/v2.php/apps/spreed/api/v1/chat/allowed") {
        data = [
          {
            ...chatFile(referenceId),
            parent: { id: 41 },
            messageParameters: { file: { id: "81", path: uploadedPath.slice(1) } },
          },
        ];
      } else if (recorded.method === "DELETE") {
        response.writeHead(204);
        response.end();
        return;
      } else if (recorded.url.pathname.includes("/bot/")) {
        data = { id: 900 };
      } else {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ocs: { meta: { statuscode: 100 }, data } }));
    };
    await withServer(
      (request, response) => {
        void respond(request, response).catch(() => response.destroy());
      },
      async (baseUrl) => {
        fixture.ctx.cfg = {
          channels: {
            "nextcloud-talk": {
              accounts: {
                work: {
                  baseUrl: `${baseUrl}/cloud`,
                  botSecret: "synthetic-bot-secret",
                  apiUser: "login-alias",
                  apiPassword: "synthetic-app-password",
                  network: { dangerouslyAllowPrivateNetwork: true },
                },
              },
            },
          },
        };
        await run(fixture);
      },
    );
  });
}
