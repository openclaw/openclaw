import { once } from "node:events";
import { createServer, request, type IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";
import type { StartedOpenClawCrablineCorrelatedAdapter } from "@openclaw/crabline";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import WebSocket, { WebSocketServer } from "ws";
import { closeQaHttpServer, dispatchQaHttpRequest } from "./bus-server.js";
import { readQaJsonResponse } from "./ignored-response-body.js";
import { readLiveQaChannelAccounts } from "./live-transports/shared/live-channel-status.js";
import {
  waitForQaTransportCondition,
  type QaTransportAdapter,
  type QaTransportState,
} from "./qa-transport.js";
import { extractQaFailureReplyText } from "./reply-failure.js";
import type { QaBusInboundMessageInput, QaBusMessage } from "./runtime-api.js";

export async function startCrablineDiscordReplies(params: {
  adapter: StartedOpenClawCrablineCorrelatedAdapter;
  state: QaTransportState;
  targets: ReadonlyMap<string, Pick<QaBusInboundMessageInput, "conversation" | "threadId">>;
}) {
  const { state } = params;
  const manifest = params.adapter.manifest;
  if (manifest.provider !== "discord") {
    return undefined;
  }
  const upstream = new URL(manifest.endpoints.apiRoot);
  const lifecycle = new AbortController();
  const sockets = new Set<WebSocket>();
  const gatewayServer = new WebSocketServer({ noServer: true });
  let generation = 0;
  let lastDelivery: { messageId: string; channelId: string } | undefined;
  const server = createServer((req, res) => {
    dispatchQaHttpRequest(res, async () => {
      const channelId =
        req.method === "POST" && req.headers.authorization === `Bot ${manifest.botToken}`
          ? req.url?.match(/^\/api\/v10\/channels\/(\d+)\/messages(?:\?.*)?$/u)?.[1]
          : undefined;
      const requestGeneration = generation;
      if (channelId) {
        lastDelivery = undefined;
      }
      const forwarded = request(upstream, {
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: upstream.host },
        signal: lifecycle.signal,
      });
      const received = new Promise<IncomingMessage>((resolve, reject) => {
        forwarded.once("response", resolve);
        forwarded.once("error", reject);
      });
      const [response] = await Promise.all([received, pipeline(req, forwarded)]);
      if (!channelId && !response.headers["content-type"]?.includes("application/json")) {
        res.writeHead(response.statusCode ?? 502, response.headers);
        await pipeline(response, res);
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 8 << 20) {
          throw new Error("Discord delivery response exceeded the reply receipt limit");
        }
        chunks.push(bytes);
      }
      const message: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        channelId &&
        response.statusCode &&
        response.statusCode >= 200 &&
        response.statusCode < 300
      ) {
        const messageId = isRecord(message) ? readStringValue(message.id) : undefined;
        if (!messageId || !/^\d+$/u.test(messageId)) {
          throw new Error("Discord delivery response omitted its message id");
        }
        if (requestGeneration === generation) {
          lastDelivery = { messageId, channelId };
        }
      }
      const pathname = new URL(req.url ?? "/", upstream).pathname;
      if (req.method === "GET" && /^\/api\/v10\/gateway(?:\/bot)?$/u.test(pathname)) {
        rewriteEndpointFields(message, ["url"], origins);
      } else if (/^\/api\/v10\/channels\/\d+\/messages(?:\/\d+)?$/u.test(pathname)) {
        rewriteMessageAttachmentUrls(message, origins);
      }
      const body = Buffer.from(JSON.stringify(message));
      const headers = { ...response.headers, "content-length": body.length };
      delete headers["transfer-encoding"];
      res.writeHead(response.statusCode ?? 502, headers);
      res.end(body);
    });
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Discord delivery receipt server failed to bind");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const origins = new Map([
    [upstream.origin, origin],
    [new URL(manifest.endpoints.gatewayUrl).origin, origin.replace(/^http/u, "ws")],
  ]);
  server.on("upgrade", (req, socket, head) => {
    const target = new URL(manifest.endpoints.gatewayUrl);
    const requested = new URL(req.url ?? "/", upstream);
    if (requested.pathname !== target.pathname) {
      socket.destroy();
      return;
    }
    target.search = requested.search;
    const remote = new WebSocket(target);
    sockets.add(remote);
    let client: WebSocket | undefined;
    socket.once("close", () => remote.terminate());
    remote.once("error", () => {
      socket.destroy();
      client?.terminate();
    });
    remote.once("close", (code, reason) => {
      sockets.delete(remote);
      if (client) {
        closeGatewayPeer(client, code, reason);
      } else {
        socket.destroy();
      }
    });
    remote.once("open", () => {
      gatewayServer.handleUpgrade(req, socket, head, (connection) => {
        client = connection;
        connection.on("error", () => remote.terminate());
        connection.on("close", (code, reason) => closeGatewayPeer(remote, code, reason));
        connection.on("message", (data, binary) => remote.send(data, { binary }));
        remote.on("message", (data, binary) => {
          if (!binary) {
            const event: unknown = JSON.parse(rawDataToString(data));
            if (isRecord(event)) {
              if (event.t === "READY") {
                rewriteEndpointFields(event.d, ["resume_gateway_url"], origins);
              } else if (event.t === "MESSAGE_CREATE" || event.t === "MESSAGE_UPDATE") {
                rewriteMessageAttachmentUrls(event.d, origins);
              }
            }
            connection.send(JSON.stringify(event));
            return;
          }
          connection.send(data, { binary });
        });
      });
    });
  });
  const waitForCompletedReply: NonNullable<QaTransportAdapter["waitForCompletedReply"]> = async ({
    inbound,
    gateway,
    timeoutMs = 60_000,
  }) => {
    const deadline = Date.now() + timeoutMs;
    await waitForQaTransportCondition(() => {
      const messages = state.getSnapshot().messages;
      const inboundIndex = messages.findIndex(
        (message) => message.id === inbound.id && message.direction === "inbound",
      );
      return inboundIndex >= 0 &&
        messages
          .slice(inboundIndex + 1)
          .some(
            (message) =>
              message.direction === "outbound" && message.accountId === inbound.accountId,
          )
        ? true
        : undefined;
    }, timeoutMs);
    await waitForQaTransportCondition(
      async () => {
        const accounts = await readLiveQaChannelAccounts(gateway, "discord", {
          timeoutMs: Math.max(1, deadline - Date.now()),
        });
        const account = accounts.find((entry) => entry.accountId === inbound.accountId);
        return account?.running === true &&
          account.connected === true &&
          account.restartPending !== true &&
          account.busy === false &&
          account.activeRuns === 0
          ? true
          : undefined;
      },
      Math.max(1, deadline - Date.now()),
    );
    const delivery = lastDelivery;
    if (!delivery || BigInt(delivery.messageId) <= BigInt(inbound.id)) {
      throw new Error(`Discord inbound ${inbound.id} completed without a final delivery receipt`);
    }
    const target = params.targets.get(delivery.channelId);
    if (!target) {
      throw new Error(`Discord final delivery ${delivery.messageId} has no observed destination`);
    }
    const { response, release } = await fetchWithSsrFGuard({
      url: `${manifest.endpoints.apiRoot}/v10/channels/${delivery.channelId}/messages/${delivery.messageId}`,
      init: { headers: { authorization: `Bot ${manifest.botToken}` } },
      policy: { allowPrivateNetwork: true },
      timeoutMs: Math.max(1, deadline - Date.now()),
      auditContext: "qa-lab-crabline-discord-retained-reply",
    });
    const message = await readQaJsonResponse<unknown>(
      response,
      release,
      `Discord inbound ${inbound.id} completed without a retained reply: final delivery ${delivery.messageId} unavailable`,
    );
    if (
      !isRecord(message) ||
      message.id !== delivery.messageId ||
      !isRecord(message.author) ||
      message.author.id !== manifest.botUserId
    ) {
      throw new Error(`Discord final delivery ${delivery.messageId} returned an invalid message`);
    }
    const replyToId = isRecord(message.message_reference)
      ? readStringValue(message.message_reference.message_id)
      : undefined;
    const reply: QaBusMessage = {
      id: delivery.messageId,
      accountId: params.adapter.accountId,
      direction: "outbound",
      ...target,
      senderId: manifest.botUserId,
      text: readStringValue(message.content) ?? "",
      timestamp: Date.parse(String(message.timestamp)),
      ...(replyToId ? { replyToId } : {}),
      reactions: [],
    };
    const failure = extractQaFailureReplyText(reply);
    if (failure) {
      throw new Error(failure);
    }
    return reply;
  };
  let closing: Promise<void> | undefined;
  return {
    apiBaseUrl: `${origin}/api/v10`,
    waitForCompletedReply,
    reset() {
      generation += 1;
      lastDelivery = undefined;
    },
    cleanup() {
      lifecycle.abort();
      return (closing ??= (async () => {
        for (const socket of [...sockets, ...gatewayServer.clients]) {
          socket.terminate();
        }
        await Promise.all([
          closeQaHttpServer(server),
          new Promise<void>((resolve, reject) => {
            gatewayServer.close((error) => (error ? reject(error) : resolve()));
          }),
        ]);
      })());
    },
  };
}

function rewriteEndpointFields(
  value: unknown,
  fields: readonly string[],
  origins: ReadonlyMap<string, string>,
): void {
  if (!isRecord(value)) {
    return;
  }
  for (const field of fields) {
    const url = value[field];
    if (typeof url !== "string") {
      continue;
    }
    for (const [source, target] of origins) {
      if (url === source || url.startsWith(`${source}/`) || url.startsWith(`${source}?`)) {
        value[field] = `${target}${url.slice(source.length)}`;
        break;
      }
    }
  }
}

function rewriteMessageAttachmentUrls(value: unknown, origins: ReadonlyMap<string, string>): void {
  if (Array.isArray(value)) {
    for (const message of value) {
      rewriteMessageAttachmentUrls(message, origins);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (Array.isArray(value.attachments)) {
    for (const attachment of value.attachments) {
      rewriteEndpointFields(attachment, ["url", "proxy_url"], origins);
    }
  }
  rewriteMessageAttachmentUrls(value.referenced_message, origins);
}

function closeGatewayPeer(socket: WebSocket, code: number, reason: Buffer): void {
  if (code === 1005 || code === 1006 || code === 1015) {
    socket.terminate();
  } else {
    socket.close(code, reason);
  }
}
