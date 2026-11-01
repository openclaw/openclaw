// These attribution adapters inject synthetic wire events; they do not prove agent replies.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import path from "node:path";
import { startFeishuServer } from "@openclaw/crabline";
import { encrypt } from "nostr-tools/nip04";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  onIrcTestLine,
  startIrcTestServer,
} from "../../extensions/irc/src/irc-server.test-support.js";
import {
  generateNextcloudTalkSignature,
  verifyNextcloudTalkSignature,
} from "../../extensions/nextcloud-talk/src/signature.js";
import { createNostrRelayFixture } from "../../extensions/nostr/src/nostr-relay.test-harness.js";
import { createQaBusState } from "../../extensions/qa-lab/src/bus-state.js";
import {
  createQaStateBackedTransportAdapter,
  waitForQaTransportAccountReady,
  waitForQaTransportCondition,
  type QaTransportAdapter,
  type QaTransportGatewayConfig,
} from "../../extensions/qa-lab/src/qa-transport.js";
import {
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
} from "../../src/test-helpers/proxy-tls-fixture.js";

export const EXTRA_PAIRING_CHANNELS = [
  "irc",
  "nostr",
  "nextcloud-talk",
  "feishu",
  "line",
  "sms",
] as const;
type ExtraPairingChannel = (typeof EXTRA_PAIRING_CHANNELS)[number];

// No redirects or ambient proxy: this fixture sends only to its owned loopback listeners.
async function post(
  address: string,
  body: string,
  headers: Record<string, string>,
  ca?: string,
): Promise<void> {
  const url = new URL(address);
  if (url.hostname !== "127.0.0.1" || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("Pairing fixture HTTP effects require an owned IPv4 loopback listener");
  }
  await new Promise<void>((resolve, reject) => {
    const options = {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      ...(ca ? { ca } : {}),
    };
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, (res) => {
      res.on("error", reject);
      res.resume();
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Synthetic pairing injection failed (${res.statusCode ?? "unknown"})`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("Synthetic pairing injection timed out")));
    req.end(body);
  });
}

function adapter(
  channel: ExtraPairingChannel,
  config: QaTransportGatewayConfig,
  send: (
    input: Parameters<QaTransportAdapter["sendInbound"]>[0],
    gatewayBaseUrl: string,
  ) => Promise<void>,
  options: {
    ready?: () => Promise<void>;
    close?: () => Promise<void>;
    env?: NodeJS.ProcessEnv;
    notes?: string[];
  } = {},
): QaTransportAdapter {
  const state = createQaBusState();
  let gatewayBaseUrl = "";
  let accepting = true;
  return createQaStateBackedTransportAdapter(state, {
    id: `pairing-attribution-${channel}`,
    label: `Synthetic ${channel} pairing attribution`,
    accountId: "default",
    requiredPluginIds: [channel],
    supportedActions: [],
    async sendInbound(input) {
      if (!accepting) {
        throw new Error("Pairing attribution fixture is shutting down");
      }
      const message = state.addInboundMessage(input);
      await send(input, gatewayBaseUrl);
      return message;
    },
    createGatewayConfig: () => config,
    async waitReady(params) {
      await waitForQaTransportAccountReady({ ...params, accountId: "default", channel });
      await options.ready?.();
    },
    async prepareFlow({ gateway }) {
      gatewayBaseUrl = gateway.baseUrl;
    },
    buildAgentDelivery: ({ target }) => ({
      channel,
      to: target,
      replyChannel: channel,
      replyTo: target,
    }),
    createRuntimeEnvPatch: () => options.env ?? {},
    async handleAction() {
      throw new Error("Pairing attribution fixtures do not implement message actions");
    },
    createReportNotes: () => [
      "Synthetic wire injection only; acceptance at the provider is not proof of ingress denial.",
      "Native sender and conversation identities are fixed by each fixture; QA input identities are scenario labels only.",
      ...(options.notes ?? []),
    ],
    // Retain provider sockets until the Gateway has confirmed its own shutdown.
    cleanup: async () => {
      accepting = false;
    },
    cleanupAfterGatewayStop: options.close,
  });
}

async function ircTransport(): Promise<QaTransportAdapter> {
  const nick = "pairing-bot";
  let socket: Socket | undefined;
  const server = await startIrcTestServer((peer) => {
    socket = peer;
    onIrcTestLine(peer, (line) => {
      if (line.startsWith("USER ")) {
        peer.write(`:server 001 ${nick} :welcome\r\n`);
      } else if (line.startsWith("PING ")) {
        peer.write(`PONG ${line.slice(5)}\r\n`);
      }
    });
  });
  return adapter(
    "irc",
    {
      channels: {
        irc: {
          enabled: true,
          host: "127.0.0.1",
          port: server.port,
          tls: false,
          nick,
          username: nick,
          realname: "Synthetic pairing fixture",
          dmPolicy: "pairing",
          allowFrom: [],
          channels: [],
        },
      },
    },
    async ({ text }) => {
      if (!socket || socket.destroyed) {
        throw new Error("Synthetic IRC owner has no connected socket");
      }
      socket.write(
        `:pairing-driver!fixture@synthetic.invalid PRIVMSG ${nick} :${text.replace(/[\r\n]/gu, " ")}\r\n`,
      );
    },
    { close: () => server.close() },
  );
}

async function nostrTransport(): Promise<QaTransportAdapter> {
  const relay = await createNostrRelayFixture();
  const recipientKey = generateSecretKey();
  const senderKey = generateSecretKey();
  const recipient = getPublicKey(recipientKey);
  return adapter(
    "nostr",
    {
      channels: {
        nostr: {
          enabled: true,
          privateKey: Buffer.from(recipientKey).toString("hex"),
          relays: [relay.url],
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    },
    async ({ text }) => {
      relay.sendIncoming([
        finalizeEvent(
          {
            kind: 4,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["p", recipient],
              ["nonce", randomUUID()],
            ],
            content: encrypt(senderKey, recipient, text),
          },
          senderKey,
        ),
      ]);
    },
    {
      ready: async () => {
        await waitForQaTransportCondition(() => (relay.subscriptions.length ? true : undefined));
      },
      close: relay.close,
    },
  );
}

async function readFixtureBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.length;
    if (bytes > 64 * 1024) {
      throw new Error("Synthetic OCS request exceeds 64 KiB");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function nextcloudTransport(): Promise<QaTransportAdapter> {
  const secret = randomBytes(24).toString("hex");
  const apiPassword = randomBytes(24).toString("hex");
  const auth = `Basic ${Buffer.from(`fixture:${apiPassword}`).toString("base64")}`;
  const room = "pairing-fixture-room";
  const server = createServer((req, res) => {
    const reply = (code: number, data: object) => {
      res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(data));
    };
    void (async () => {
      if (req.method === "GET" && req.url === `/ocs/v2.php/apps/spreed/api/v4/room/${room}`) {
        reply(req.headers.authorization === auth ? 200 : 401, { ocs: { data: { type: 1 } } });
        return;
      }
      if (
        req.method === "POST" &&
        req.url === `/ocs/v2.php/apps/spreed/api/v1/bot/${room}/message`
      ) {
        const payload: unknown = JSON.parse(await readFixtureBody(req));
        const body =
          payload && typeof payload === "object" && "message" in payload
            ? payload.message
            : undefined;
        const random = req.headers["x-nextcloud-talk-bot-random"];
        const signature = req.headers["x-nextcloud-talk-bot-signature"];
        const valid =
          typeof body === "string" &&
          typeof random === "string" &&
          typeof signature === "string" &&
          verifyNextcloudTalkSignature({ body, random, signature, secret });
        reply(valid ? 200 : 401, { ocs: { data: { id: 1 } } });
        return;
      }
      reply(404, { error: "Unsupported synthetic OCS route" });
    })().catch(() => reply(400, { error: "Invalid synthetic OCS request" }));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Synthetic OCS fixture did not bind a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const webhookPath = "/pairing-attribution/nextcloud-talk";
  return adapter(
    "nextcloud-talk",
    {
      channels: {
        "nextcloud-talk": {
          enabled: true,
          baseUrl,
          botSecret: secret,
          apiUser: "fixture",
          apiPassword,
          network: { dangerouslyAllowPrivateNetwork: true },
          legacyWebhook: false,
          webhookPath,
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    },
    async ({ text }, gatewayBaseUrl) => {
      const body = JSON.stringify({
        type: "Create",
        actor: { type: "Person", id: "pairing-driver", name: "Synthetic driver" },
        object: {
          type: "Note",
          id: randomUUID(),
          name: text,
          content: text,
          mediaType: "text/plain",
        },
        target: { type: "Collection", id: room, name: "Synthetic direct room" },
      });
      const signed = generateNextcloudTalkSignature({ body, secret });
      await post(new URL(webhookPath, gatewayBaseUrl).href, body, {
        "content-type": "application/json",
        "x-nextcloud-talk-random": signed.random,
        "x-nextcloud-talk-signature": signed.signature,
        "x-nextcloud-talk-backend": baseUrl,
      });
    },
    {
      close: async () => {
        server.closeAllConnections();
        await server[Symbol.asyncDispose]();
      },
      notes: [
        "The local room API identifies the synthetic room as direct; webhook Collection alone is group-shaped.",
      ],
    },
  );
}

async function feishuTransport(outputDir: string): Promise<QaTransportAdapter> {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const caPath = path.join(outputDir, "feishu-fixture-ca.pem");
  await writeFile(caPath, PROXY_FIXTURE_CERTIFICATE, { mode: 0o600 });
  const server = await startFeishuServer({
    tls: { key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE },
    recorderPath: path.join(outputDir, "feishu-synthetic-wire.jsonl"),
    maxMessages: 32,
    maxPendingEvents: 8,
    maxSockets: 2,
  });
  const { manifest } = server;
  return adapter(
    "feishu",
    {
      channels: {
        feishu: {
          enabled: true,
          appId: manifest.appId,
          appSecret: manifest.appSecret,
          domain: manifest.baseUrl,
          connectionMode: "websocket",
          dmPolicy: "pairing",
          allowFrom: [],
          typingIndicator: false,
          resolveSenderNames: false,
          streaming: { mode: "off" },
        },
      },
    },
    async ({ text }) => {
      await post(
        manifest.endpoints.adminInboundUrl,
        JSON.stringify({
          chatId: "oc_pairing_fixture",
          senderId: "ou_pairing_driver",
          text,
          chatType: "p2p",
        }),
        {
          "content-type": "application/json",
          "x-crabline-admin-token": manifest.adminToken,
        },
        PROXY_FIXTURE_CERTIFICATE,
      );
    },
    {
      env: { NODE_EXTRA_CA_CERTS: caPath },
      close: () => server.close(),
      notes: [
        "Custom HTTPS origin and fixture CA preserve TLS and hostname verification; native WebSocket authentication remains enabled. Optional sender-name lookup is disabled because this fixture implements messaging, not the Contacts API.",
      ],
    },
  );
}

function deniedWebhookTransport(channel: "line" | "sms"): QaTransportAdapter {
  const secret = randomBytes(24).toString("hex");
  const webhookPath = `/pairing-attribution/${channel}`;
  const publicWebhookUrl = `https://synthetic.invalid${webhookPath}`;
  const accountSid = `AC${randomBytes(16).toString("hex")}`;
  const config =
    channel === "line"
      ? {
          channels: {
            line: {
              enabled: true,
              channelAccessToken: "synthetic-fixture-token",
              channelSecret: secret,
              webhookPath,
              dmPolicy: "allowlist" as const,
              allowFrom: [],
            },
          },
        }
      : {
          channels: {
            sms: {
              enabled: true,
              accountSid,
              authToken: secret,
              fromNumber: "+12025550123",
              publicWebhookUrl,
              webhookPath,
              dmPolicy: "allowlist" as const,
              allowFrom: [],
            },
          },
        };
  return adapter(
    channel,
    config,
    async ({ text }, gatewayBaseUrl) => {
      if (channel === "line") {
        const body = JSON.stringify({
          destination: "Ufixture-bot",
          events: [
            {
              type: "message",
              webhookEventId: randomUUID(),
              timestamp: Date.now(),
              source: { type: "user", userId: "Ufixture-driver" },
              replyToken: "synthetic-reply-token",
              mode: "active",
              deliveryContext: { isRedelivery: false },
              message: { type: "text", id: randomUUID(), text },
            },
          ],
        });
        await post(new URL(webhookPath, gatewayBaseUrl).href, body, {
          "content-type": "application/json",
          "x-line-signature": createHmac("sha256", secret).update(body).digest("base64"),
        });
        return;
      }
      const form: Record<string, string> = {
        AccountSid: accountSid,
        From: "+12025550124",
        To: "+12025550123",
        Body: text,
        MessageSid: `SM${randomBytes(16).toString("hex")}`,
        NumMedia: "0",
      };
      const signed =
        publicWebhookUrl +
        Object.keys(form)
          .toSorted()
          .map((key) => `${key}${form[key]}`)
          .join("");
      await post(new URL(webhookPath, gatewayBaseUrl).href, new URLSearchParams(form).toString(), {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": createHmac("sha1", secret).update(signed).digest("base64"),
      });
    },
    {
      notes: [
        "Narrower coverage: signed ingress with an empty allowlist, not pairing mode. Denial precedes profile/media/agent work and provider sends; preserve dmPolicy=allowlist.",
      ],
    },
  );
}

export async function createExtraPairingTransport(
  channel: ExtraPairingChannel,
  outputDir: string,
): Promise<QaTransportAdapter> {
  switch (channel) {
    case "irc":
      return await ircTransport();
    case "nostr":
      return await nostrTransport();
    case "nextcloud-talk":
      return await nextcloudTransport();
    case "feishu":
      return await feishuTransport(outputDir);
    default:
      return deniedWebhookTransport(channel);
  }
}
