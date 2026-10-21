import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliverReplies } from "../monitor.js";
import { sendMessageSignal } from "../send.js";

type RpcEnvelope = {
  id?: string | number;
  method?: string;
  params?: { message?: string; attachments?: string[] };
};

const runtime = { log() {}, error() {} } as RuntimeEnv;

describe("signal retirement handoff", () => {
  let server: http.Server;
  let cfg: OpenClawConfig;
  let baseUrl: string;
  let requests: RpcEnvelope[];
  let dir: string;
  let retired: boolean;

  beforeEach(async () => {
    requests = [];
    retired = false;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-retirement-"));
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      });
      request.on("end", () => {
        const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RpcEnvelope;
        requests.push(envelope);
        retired = true;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: envelope.id,
            result: { timestamp: 1700000000999, results: [{ type: "SUCCESS" }] },
          }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Signal test server did not expose a TCP port");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    cfg = {
      channels: {
        signal: {
          accounts: {
            default: {
              account: "+15550001111",
              transport: { kind: "external-native", url: baseUrl },
            },
          },
        },
      },
    };
  });

  afterEach(async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("sends one chunk and skips the next chunk after retirement", async () => {
    await expect(
      deliverReplies({
        cfg,
        replies: [{ text: "abcdefghij" }],
        target: "+15551234567",
        baseUrl,
        account: "+15550001111",
        accountId: "default",
        runtime,
        maxBytes: 1024 * 1024,
        textLimit: 4,
        chunkMode: "length",
        assertDirectAdapterHandoff: () => {
          if (retired) {
            throw new Error("signal delivery retired before send");
          }
        },
      }),
    ).rejects.toThrow("signal delivery retired before send");
    expect(requests.map((request) => request.params?.message)).toEqual(["abcd"]);
  });

  it("does not send after retirement during the media read", async () => {
    const imagePath = path.join(dir, "chart.png");
    await fs.writeFile(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    let mediaRetired = false;
    await expect(
      sendMessageSignal("+15551234567", "chart", {
        cfg,
        baseUrl,
        account: "+15550001111",
        mediaUrl: imagePath,
        mediaLocalRoots: [dir],
        mediaReadFile: async (filePath) => {
          const bytes = await fs.readFile(filePath);
          mediaRetired = true;
          return bytes;
        },
        assertDirectAdapterHandoff: () => {
          if (mediaRetired) {
            throw new Error("signal delivery retired before send");
          }
        },
      }),
    ).rejects.toThrow("signal delivery retired before send");
    expect(requests).toHaveLength(0);
  });
});
