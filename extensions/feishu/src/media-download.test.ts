import fs from "node:fs/promises";
import http from "node:http";
import { withEnvAsync, withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";

const messageResourceGet = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({
  createFeishuClient: () => ({ im: { messageResource: { get: messageResourceGet } } }),
}));

const cfg: ClawdbotConfig = {
  channels: { feishu: { appId: "synthetic-app-id", appSecret: "synthetic-app-secret" } },
};
let saveMessageResourceFeishu: typeof import("./media.js").saveMessageResourceFeishu;

beforeAll(async () => {
  ({ saveMessageResourceFeishu } = await import("./media.js"));
});

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.resetModules();
});

describe("saveMessageResourceFeishu stream ownership", () => {
  it.each([false, true])(
    "closes an acquired stream on terminal storage failure (teardown throws: %s)",
    async (teardownThrows) => {
      await withTempDir("openclaw-feishu-download-", (stateDir) =>
        withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
          let serverSawClose = false;
          await withServer(
            (_request, response) => {
              response.once("close", () => {
                serverSawClose = true;
              });
              response.writeHead(200, {
                "content-type": "image/jpeg",
                "content-length": "1024",
              });
              response.flushHeaders();
            },
            async (baseUrl) => {
              const stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
                http.get(`${baseUrl}/media`, resolve).once("error", reject);
              });
              messageResourceGet.mockResolvedValueOnce({
                getReadableStream: () => stream,
                headers: { "content-type": "image/jpeg" },
              });
              const storageError = Object.assign(new Error("media directory unavailable"), {
                code: "EACCES",
              });
              const mkdir = vi.spyOn(fs, "mkdir").mockRejectedValueOnce(storageError);
              const iterate = vi.spyOn(stream, Symbol.asyncIterator);
              const destroySource = stream.destroy.bind(stream);
              const destroy = vi.spyOn(stream, "destroy").mockImplementationOnce((error) => {
                const result = destroySource(error);
                if (teardownThrows) {
                  throw new Error("source teardown failed");
                }
                return result;
              });
              const download = saveMessageResourceFeishu({
                cfg,
                messageId: "om_storage_failure",
                fileKey: "img_key_storage_failure",
                type: "image",
                maxBytes: 1024,
              });
              const settled = download.then(
                () => undefined,
                () => undefined,
              );
              try {
                await expect(download).rejects.toBe(storageError);
                expect(iterate).not.toHaveBeenCalled();
                expect(stream.destroyed).toBe(true);
                await vi.waitFor(() => expect(serverSawClose).toBe(true));
              } finally {
                mkdir.mockRestore();
                iterate.mockRestore();
                destroy.mockRestore();
                stream.destroy();
                await settled;
              }
            },
          );
        }),
      );
    },
  );
});
