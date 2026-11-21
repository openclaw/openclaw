import { randomUUID, createHash } from "node:crypto";
// Transplanted into the exact candidate only on a disposable hosted VM.
import fs from "node:fs";
import path from "node:path";
import {
  createClient,
  ClientEvent,
  RoomEvent,
  MatrixEventEvent,
  type MatrixEvent,
} from "matrix-js-sdk/lib/matrix.js";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, expect, it } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import { MatrixClient } from "./sdk.js";
import { sendMessageMatrix } from "./send.js";

const homeserver = process.env.GOAL24_HOMESERVER!;
const observations: Record<string, unknown> = {};
const save = () =>
  fs.writeFileSync(process.env.GOAL24_LIVE_OUTPUT!, JSON.stringify(observations, null, 2));
// Only the host text-service adapter is synthetic; SDK, HTTP, server, durable plan,
// encryption and recipient are real. No transport or crypto module is mocked.
beforeEach(() =>
  installMatrixTestRuntime({ channel: { text: createPluginRuntimeMock().channel.text } }),
);
afterAll(async () => {
  save();
  await closeOpenClawStateDatabaseAsync();
});

type Account = { user_id: string; access_token: string; device_id: string };
type Event = { event_id: string; type: string; sender: string; content: Record<string, unknown> };
async function api<T>(
  account: Account | undefined,
  method: string,
  endpoint: string,
  body?: object,
): Promise<T> {
  const response = await fetch(homeserver + "/_matrix/client/v3" + endpoint, {
    method,
    headers: {
      "content-type": "application/json",
      ...(account ? { authorization: "Bearer " + account.access_token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  // Never include response bodies in assertions: registration replies contain tokens.
  expect(response.status, method + " " + endpoint.split("?")[0]).toBe(200);
  return (await response.json()) as T;
}
async function registerAccount(label: string) {
  return await api<Account>(undefined, "POST", "/register", {
    username: label + randomUUID().replaceAll("-", ""),
    password: randomUUID(),
    device_id: label,
    auth: { type: "m.login.dummy" },
  });
}
async function pair(encrypted = false) {
  const alice = await registerAccount("alice"),
    bob = await registerAccount("bob");
  const created = await api<{ room_id: string }>(alice, "POST", "/createRoom", {
    preset: "private_chat",
    invite: [bob.user_id],
    ...(encrypted
      ? {
          initial_state: [
            {
              type: "m.room.encryption",
              state_key: "",
              content: { algorithm: "m.megolm.v1.aes-sha2" },
            },
          ],
        }
      : {}),
  });
  const room = created.room_id;
  await api(bob, "POST", "/join/" + encodeURIComponent(room), {});
  return { alice, bob, room };
}
function sender(user: Account, url = homeserver, encryption = false) {
  return new MatrixClient(url, user.access_token, {
    userId: user.user_id,
    deviceId: user.device_id,
    encryption,
    autoBootstrapCrypto: false,
    ssrfPolicy: { allowPrivateNetwork: true },
    cryptoDatabasePrefix: "goal24-" + randomUUID(),
    idbSnapshotPath: path.join(process.env.OPENCLAW_TEST_HOME!, randomUUID() + ".sqlite"),
  });
}
async function messages(user: Account, room: string) {
  return (
    await api<{ chunk: Event[] }>(
      user,
      "GET",
      "/rooms/" + encodeURIComponent(room) + "/messages?dir=b&limit=100",
    )
  ).chunk;
}
const cfg = { channels: { matrix: { textChunkLimit: 4000 } } };

it("authenticated SDK send reaches the recipient", async () => {
  const { alice, bob, room } = await pair();
  const client = sender(alice);
  const body = "goal24-authenticated-" + randomUUID();
  try {
    const result = await sendMessageMatrix(room, body, { client, cfg });
    const received = (await messages(bob, room)).filter((event) => event.content.body === body);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      event_id: result.messageId,
      sender: alice.user_id,
      type: "m.room.message",
    });
    observations.authenticated = { eventId: result.messageId, recipientEvents: received.length };
    save();
  } finally {
    await client.stopWithoutPersist();
  }
}, 60000);

it("accepted then 429 recovers one durable recipient event", async () => {
  const { alice, bob, room } = await pair();
  const body = "goal24-uncertain-" + randomUUID();
  const writes: { path: string; status: number; eventId?: string; replacedWith429: boolean }[] = [];
  const failures: string[] = [];
  await withServer(
    (request, response) => {
      void (async () => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const payload = Buffer.concat(chunks);
          const upstream = await fetch(homeserver + request.url, {
            method: request.method,
            headers: {
              "content-type": "application/json",
              authorization: request.headers.authorization ?? "",
            },
            ...(payload.length ? { body: payload } : {}),
            signal: AbortSignal.timeout(15000),
          });
          const bytes = await upstream.text();
          const sending =
            request.method === "PUT" && request.url?.includes("/send/m.room.message/");
          if (sending) {
            const accepted =
              upstream.status === 200 ? (JSON.parse(bytes) as { event_id: string }) : undefined;
            const replace = writes.length === 0 && accepted !== undefined;
            writes.push({
              path: request.url!,
              status: upstream.status,
              eventId: accepted?.event_id,
              replacedWith429: replace,
            });
            if (replace) {
              // Acceptance has already happened in Synapse. Only the response is lost/replaced.
              response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
              response.end(
                JSON.stringify({
                  errcode: "M_LIMIT_EXCEEDED",
                  error: "synthetic lost success",
                  retry_after_ms: 1,
                }),
              );
              return;
            }
          }
          response.writeHead(upstream.status, { "content-type": "application/json" });
          response.end(bytes);
        } catch (error) {
          failures.push(error instanceof Error ? error.name : "proxy failure");
          response.writeHead(500).end();
        }
      })();
    },
    async (url) => {
      const client = sender(alice, url);
      let receipts = 0;
      try {
        const result = await sendMessageMatrix(room, body, {
          client,
          cfg,
          deliveryQueueId: randomUUID(),
          deliveryPartIndex: 0,
          deliveryPartCount: 1,
          onDeliveryResult: () => {
            receipts++;
          },
        });
        expect(failures).toEqual([]);
        expect(writes).toHaveLength(2);
        expect(writes.map((write) => write.status)).toEqual([200, 200]);
        expect(writes.map((write) => write.replacedWith429)).toEqual([true, false]);
        expect(new Set(writes.map((write) => write.path)).size).toBe(1);
        expect(new Set(writes.map((write) => write.eventId))).toEqual(new Set([result.messageId]));
        expect(receipts).toBe(1);
        const received = (await messages(bob, room)).filter((event) => event.content.body === body);
        expect(received).toHaveLength(1);
        expect(received[0].event_id).toBe(result.messageId);
        observations.recovery = {
          writes,
          recipientEvents: received.length,
          receipts,
          owner: "sendMessageMatrix durable plan + Matrix SDK scheduler; no Gateway queue restart",
        };
        save();
      } finally {
        await client.stopWithoutPersist();
      }
    },
  );
}, 90000);

it("encrypted SDK send is decrypted by an independent recipient", async () => {
  const { alice, bob, room } = await pair(true);
  const client = sender(alice, homeserver, true);
  const recipient = createClient({
    baseUrl: homeserver,
    userId: bob.user_id,
    deviceId: bob.device_id,
    accessToken: bob.access_token,
  });
  const body = "goal24-encrypted-" + randomUUID();
  const cleanups: (() => void)[] = [];
  try {
    await recipient.initRustCrypto({ useIndexedDB: false });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("recipient initial sync timeout")), 30000);
      const onSync = (state: string) => {
        if (state === "PREPARED" || state === "SYNCING") {
          clearTimeout(timer);
          recipient.off(ClientEvent.Sync, onSync);
          resolve();
        }
      };
      recipient.on(ClientEvent.Sync, onSync);
      cleanups.push(() => {
        clearTimeout(timer);
        recipient.off(ClientEvent.Sync, onSync);
      });
    });
    // Observe failure even when startup throws before the wait is awaited.
    void ready.catch(() => {});
    await recipient.startClient();
    await ready;
    await client.start({ readyTimeoutMs: 45000 });
    const received = new Promise<{ id: string | undefined; body: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("recipient decryption timeout")), 45000);
      const inspect = (event: MatrixEvent) => {
        if (event.getRoomId() !== room) {
          return;
        }
        const content = event.getContent();
        if (content.body === body) {
          clearTimeout(timer);
          resolve({ id: event.getId(), body: content.body });
        }
      };
      recipient.on(RoomEvent.Timeline, inspect);
      recipient.on(MatrixEventEvent.Decrypted, inspect);
      cleanups.push(() => {
        clearTimeout(timer);
        recipient.off(RoomEvent.Timeline, inspect);
        recipient.off(MatrixEventEvent.Decrypted, inspect);
      });
    });
    // Observe failure even when sending throws before the wait is awaited.
    void received.catch(() => {});
    const result = await sendMessageMatrix(room, body, { client, cfg });
    const decrypted = await received;
    expect(decrypted).toEqual({ id: result.messageId, body });
    const raw = (await messages(bob, room)).filter((event) => event.event_id === result.messageId);
    expect(raw).toHaveLength(1);
    expect(raw[0].type).toBe("m.room.encrypted");
    expect(raw[0].content.algorithm).toBe("m.megolm.v1.aes-sha2");
    expect(raw[0].content.body).toBeUndefined();
    expect(typeof raw[0].content.ciphertext).toBe("string");
    observations.encrypted = {
      eventId: result.messageId,
      recipientEvents: raw.length,
      decryptedBodyHash: createHash("sha256").update(body).digest("hex"),
      wireType: raw[0].type,
      algorithm: raw[0].content.algorithm,
      crossSigningVerified: false,
    };
    save();
  } finally {
    for (const cleanup of cleanups) {
      cleanup();
    }
    recipient.stopClient();
    await client.stopWithoutPersist();
  }
}, 150000);
