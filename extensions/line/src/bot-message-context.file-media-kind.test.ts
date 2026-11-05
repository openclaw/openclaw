import fs from "node:fs/promises";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildLineMessageContext } from "./bot-message-context.js";
import { downloadLineMedia } from "./download.js";
import type { ResolvedLineAccount } from "./types.js";
import { createTestMessageEvent } from "./webhook-spool.test-support.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");

const account: ResolvedLineAccount = {
  accountId: "default",
  enabled: true,
  channelAccessToken: "token",
  channelSecret: "secret",
  tokenSource: "config",
  config: {},
};

describe("LINE file message media kind", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["diagram.png", "image/png", PNG, "image/png", "image"],
    ["upload.bin", "application/octet-stream", PNG, "image/png", "image"],
    ["report.pdf", "application/pdf", PDF, "application/pdf", "document"],
    ["report.png", "image/png", PDF, "application/pdf", "document"],
  ] as const)(
    "hands the agent %s served as %s with the detected media kind",
    async (fileName, header, bytes, contentType, kind) => {
      await withOpenClawTestState({ label: "line-file-media-kind" }, async (state) => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
          String(input instanceof Request ? input.url : input).endsWith("/message/file-1/content")
            ? new Response(bytes, { headers: { "content-type": header } })
            : new Response("{}", { status: 404 }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const media = await downloadLineMedia("file-1", account.channelAccessToken, 1024, {
          originalFilename: fileName,
        });
        const context = await buildLineMessageContext({
          event: createTestMessageEvent({
            message: { id: "file-1", type: "file", fileName, fileSize: bytes.length },
            source: { type: "user", userId: "user-1" },
            webhookEventId: "evt-file-1",
          }),
          allMedia: [{ path: media.path, contentType: media.contentType, fileName }],
          cfg: { session: { store: state.path("sessions.json") } },
          account,
          commandAuthorized: true,
        });

        expect(await fs.readFile(media.path)).toEqual(bytes);
        expect(context?.ctxPayload.media).toEqual([
          expect.objectContaining({
            path: media.path,
            contentType,
            kind,
          }),
        ]);
      });
    },
  );
});
