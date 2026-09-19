// Real matrix-js-sdk HTTP sends must revalidate authority for every wire event.
import http from "node:http";
import { resetPluginBlobStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, describe, expect, it } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { MatrixClient } from "./sdk.js";
import { sendMessageMatrix } from "./send.js";

afterEach(() => resetPluginBlobStoreForTests());

describe("Matrix per-wire send authority", () => {
  for (const durable of [false, true]) {
    it.each([
      "unchanged",
      "between chunks",
      "during preparation",
      "redirect unchanged",
      "redirect revoked",
    ] as const)(`guards %s with durable=${durable}`, async (boundary) => {
      installMatrixTestRuntime({
        channel: {
          text: {
            ...createPluginRuntimeMock().channel.text,
            resolveTextChunkLimit: () => 5,
            resolveChunkMode: () => "length",
            resolveMarkdownTableMode: () => "code",
            chunkMarkdownTextWithMode: (text, limit) => chunkTextForOutbound(text, limit),
          },
        },
      });
      let authorized = true;
      let stateReads = 0;
      let redirected = false;
      let accepted = 0;
      const writes: string[] = [];
      const receipts: string[] = [];
      const server = http.createServer((request, response) => {
        const url = request.url ?? "";
        response.setHeader("content-type", "application/json");
        if (url.includes("/state/m.room.encryption")) {
          stateReads += 1;
          if (boundary === "during preparation" && stateReads === 2) {
            authorized = false;
          }
          response.writeHead(404);
          response.end(JSON.stringify({ errcode: "M_NOT_FOUND", error: "unencrypted room" }));
        } else if (url.includes("/account/whoami")) {
          response.end(JSON.stringify({ user_id: "@bot:example.org", device_id: "fixture" }));
        } else if (request.method === "PUT" && url.includes("/send/m.room.message/")) {
          writes.push(url);
          if (boundary.startsWith("redirect") && !redirected) {
            redirected = true;
            authorized = boundary === "redirect unchanged";
            response.writeHead(307, { location: `${url}?redirected=1` });
            response.end();
            return;
          }
          accepted += 1;
          if (boundary === "between chunks" && writes.length === 1) {
            authorized = false;
          }
          response.end(JSON.stringify({ event_id: `$event-${accepted}` }));
        } else {
          response.writeHead(500);
          response.end(JSON.stringify({ errcode: "M_UNKNOWN", error: `unexpected ${url}` }));
        }
      });
      let client: MatrixClient | undefined;
      try {
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("missing loopback address");
        }
        client = new MatrixClient(`http://127.0.0.1:${address.port}`, "fixture-token", {
          userId: "@bot:example.org",
          deviceId: "fixture",
          encryption: false,
          autoBootstrapCrypto: false,
          ssrfPolicy: { allowPrivateNetwork: true },
        });
        const send = sendMessageMatrix("!room:example.org", "AAAAA BBBBB CCCCC", {
          client,
          cfg: {},
          ...(durable
            ? {
                deliveryQueueId: `authority-${boundary}`,
                deliveryPartIndex: 0,
                deliveryPartCount: 1,
              }
            : {}),
          onPlatformSendDispatch: async () => {
            if (!authorized) {
              throw new Error("completion authority revoked");
            }
          },
          onDeliveryResult: (result) => {
            receipts.push(result.messageId);
          },
        });
        if (boundary === "unchanged" || boundary === "redirect unchanged") {
          await expect(send).resolves.toMatchObject({ messageId: "$event-3" });
        } else {
          await expect(send).rejects.toThrow("completion authority revoked");
        }
        const expectedWrites =
          boundary === "unchanged"
            ? 3
            : boundary === "redirect unchanged"
              ? 4
              : boundary === "during preparation"
                ? 0
                : 1;
        const expectedReceipts =
          boundary === "unchanged" || boundary === "redirect unchanged"
            ? 3
            : boundary === "between chunks"
              ? 1
              : 0;
        expect(writes).toHaveLength(expectedWrites);
        expect(receipts).toHaveLength(expectedReceipts);
        expect(new Set(writes).size).toBe(expectedWrites);
      } finally {
        await client?.stopWithoutPersist();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
    });
  }
});
