import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuMediaList } from "./bot-content.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

const resources = new Map<string, { bytes: Buffer; header: string }>();
let server: Server;
let cfg: ClawdbotConfig;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url?.startsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "t", expire: 7200 }));
      return;
    }
    const fileKey = request.url?.match(/\/resources\/([^/?]+)\?type=file$/)?.[1];
    const resource = fileKey ? resources.get(fileKey) : undefined;
    if (!resource) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 404, msg: "not found" }));
      return;
    }
    response.writeHead(200, { "content-type": resource.header });
    response.end(resource.bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cfg = {
    channels: {
      feishu: {
        enabled: true,
        appId: "cli_file_media_kind",
        appSecret: "loopback-placeholder",
        domain: `http://127.0.0.1:${port}`,
      },
    },
  } as ClawdbotConfig;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Feishu file media kind", () => {
  it.each([
    {
      label: "a PNG file served as octet-stream",
      bytes: PNG,
      header: "application/octet-stream",
      contentType: "image/png",
      kind: "image",
    },
    {
      label: "a PDF file",
      bytes: PDF,
      header: "application/pdf",
      contentType: "application/pdf",
      kind: "document",
    },
    {
      label: "PDF bytes mislabeled as an image",
      bytes: PDF,
      header: "image/png",
      contentType: "application/pdf",
      kind: "document",
    },
  ])("hands the agent $label as $kind", async (fixture) => {
    await withOpenClawTestState({ label: "feishu-file-media-kind" }, async () => {
      const fileKey = `file_${fixture.kind}_${fixture.header.replace(/\W/g, "_")}`;
      resources.set(fileKey, { bytes: fixture.bytes, header: fixture.header });

      const media = await resolveFeishuMediaList({
        cfg,
        messageId: "om_file",
        messageType: "file",
        content: JSON.stringify({ file_key: fileKey, file_name: "upload.bin" }),
        maxBytes: 1024,
      });

      expect(media).toEqual([
        { path: expect.any(String), contentType: fixture.contentType, kind: fixture.kind },
      ]);
      expect(await fs.readFile(media[0]?.path ?? "")).toEqual(fixture.bytes);
    });
  });

  it("hands the agent an image attached as a top-level post file as image", async () => {
    await withOpenClawTestState({ label: "feishu-post-file-media-kind" }, async () => {
      resources.set("file_post_png", { bytes: PNG, header: "application/octet-stream" });
      const content = [[{ tag: "text", text: "see attached" }]];

      const media = await resolveFeishuMediaList({
        cfg,
        messageId: "om_post",
        messageType: "post",
        content: JSON.stringify({
          title: "",
          content,
          content_v2: content,
          files: [{ file_key: "file_post_png", file_name: "IMG_2041.png", is_folder: false }],
        }),
        maxBytes: 1024,
      });

      expect(media).toEqual([
        { path: expect.any(String), contentType: "image/png", kind: "image" },
      ]);
    });
  });
});
