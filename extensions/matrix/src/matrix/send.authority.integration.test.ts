// Real matrix-js-sdk HTTP sends must revalidate authority for every wire event.
import http from "node:http";
import { promisify } from "node:util";
import { resetPluginBlobStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, expect, it } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { MatrixClient } from "./sdk.js";
import { sendMessageMatrix } from "./send.js";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginBlobStoreForTests();
});

it.each<[string, boolean, number, number]>([
  ["between chunks", true, 1, 1],
  ["during preparation", false, 0, 0],
  ["redirect unchanged", false, 4, 3],
  ["redirect revoked", true, 1, 0],
])("guards %s (durable=%s)", async (boundary, durable, expectedWrites, expectedReceipts) => {
  const text = createPluginRuntimeMock().channel.text;
  text.resolveChunkMode = () => "length";
  text.chunkMarkdownTextWithMode = (value, limit) => chunkTextForOutbound(value, limit);
  installMatrixTestRuntime({ channel: { text } });
  let authorized = true;
  let stateReads = 0;
  let accepted = 0;
  const writes: string[] = [];
  let receipts = 0;
  const server = http.createServer((request, response) => {
    const url = request.url ?? "";
    const json = (body: object, code = 200) => {
      response.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (url.includes("/state/m.room.encryption")) {
      if (boundary === "during preparation" && ++stateReads === 2) {
        authorized = false;
      }
      json({ errcode: "M_NOT_FOUND", error: "unencrypted room" }, 404);
    } else if (url.includes("/account/whoami")) {
      json({ user_id: "@bot:example.org", device_id: "fixture" });
    } else if (request.method === "PUT" && url.includes("/send/m.room.message/")) {
      writes.push(url);
      if (boundary.startsWith("redirect") && writes.length === 1) {
        authorized = boundary === "redirect unchanged";
        response.writeHead(307, { location: `${url}?redirected=1` }).end();
        return;
      }
      if (boundary === "between chunks" && writes.length === 1) {
        authorized = false;
      }
      json({ event_id: `$event-${++accepted}` });
    } else {
      json({ errcode: "M_UNKNOWN", error: `unexpected ${url}` }, 500);
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
      cfg: { channels: { matrix: { textChunkLimit: 5 } } },
      ...(durable
        ? { deliveryQueueId: `authority-${boundary}`, deliveryPartIndex: 0, deliveryPartCount: 1 }
        : {}),
      onPlatformSendDispatch: async () => {
        if (!authorized) {
          throw new Error("completion authority revoked");
        }
      },
      onDeliveryResult: () => {
        receipts += 1;
      },
    });
    if (boundary === "redirect unchanged") {
      await expect(send).resolves.toMatchObject({ messageId: "$event-3" });
    } else {
      await expect(send).rejects.toThrow("completion authority revoked");
    }
    expect(writes).toHaveLength(expectedWrites);
    expect(receipts).toBe(expectedReceipts);
    expect(new Set(writes).size).toBe(expectedWrites);
  } finally {
    await client?.stopWithoutPersist();
    const closed = promisify(server.close.bind(server))();
    server.closeAllConnections();
    await closed;
  }
});
