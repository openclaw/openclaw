import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { listAgentIds, resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { ChannelStatusIssue } from "openclaw/plugin-sdk/channel-contract";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  waitUntilAbort,
} from "openclaw/plugin-sdk/channel-outbound";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { sendJsonNoStore as writeJsonResponse } from "openclaw/plugin-sdk/http-response-runtime";
import {
  isHostNoticePayload,
  isReplyPayloadTerminalContent,
} from "openclaw/plugin-sdk/reply-payload";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
  readAccountStatusSnapshot,
  resolveEnabledConfiguredAccountId,
} from "openclaw/plugin-sdk/status-helpers";
import { filterStringEntries, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { boundedJsonUtf8Bytes } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  registerPluginHttpRoute,
} from "openclaw/plugin-sdk/webhook-ingress";
import {
  runDetachedWebhookWork,
  sendHttpRequestRejection,
} from "openclaw/plugin-sdk/webhook-request-guards";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { A2A_CHANNEL_ID, a2aChannelSetupPlugin } from "./channel-base.js";
import { dispatchA2aInbound } from "./inbound.js";
import { sendA2aChannelText } from "./outbound.js";
import {
  A2aProtocolError,
  A2aRpcRequestSchema,
  A2aSendMessageParamsSchema,
  A2aTaskRequestParamsSchema,
  extractA2aMessageText,
  resolveA2aRpcMethod,
} from "./protocol.js";
import { getA2aChannelRuntime } from "./runtime.js";
import { A2aTaskStore } from "./task-store.js";
import type { A2aChannelConfig, ResolvedA2aChannelAccount } from "./types.js";

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
// This cap stays enforced when an operator disables the per-peer rate limit.
const MAX_BATCH_REQUESTS = 30;
const DEFAULT_REPLY_TIMEOUT_MS = 120_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

type A2aRpcIdentifier = string | number | null;

type A2aRpcResponse =
  | { jsonrpc: "2.0"; id: A2aRpcIdentifier; result: unknown }
  | { jsonrpc: "2.0"; id: A2aRpcIdentifier; error: { code: number; message: string } };

function createRpcError(id: A2aRpcIdentifier, code: number, message: string): A2aRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeRpcResponse(
  response: ServerResponse,
  value: A2aRpcResponse | A2aRpcResponse[],
): void {
  const measured = boundedJsonUtf8Bytes(value, MAX_RESPONSE_BODY_BYTES);
  if (measured.complete) {
    writeJsonResponse(response, 200, value);
    return;
  }
  const errorMessage = "A2A response exceeds the 1 MiB limit";
  const bounded = Array.isArray(value)
    ? value.map((entry) => createRpcError(entry.id, -32000, errorMessage))
    : createRpcError(value.id, -32000, errorMessage);
  // Request IDs can consume nearly the entire inbound budget. Drop correlation
  // only when an already-oversized response's replacement still cannot fit.
  const fallback = boundedJsonUtf8Bytes(bounded, MAX_RESPONSE_BODY_BYTES).complete
    ? bounded
    : Array.isArray(bounded)
      ? bounded.map(() => createRpcError(null, -32000, errorMessage))
      : createRpcError(null, -32000, errorMessage);
  writeJsonResponse(response, 200, fallback);
}

function resolvePeerName(request: IncomingMessage, config: A2aChannelConfig): string | undefined {
  const authorization = request.headers.authorization;
  const token = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!token) {
    return undefined;
  }
  const presentedDigest = createHash("sha256").update(token).digest();
  for (const [peerName, peer] of Object.entries(config.peers ?? {})) {
    const configuredDigest = createHash("sha256").update(peer.token).digest();
    if (timingSafeEqual(presentedDigest, configuredDigest)) {
      return peerName;
    }
  }
  return undefined;
}

function resolveRequestOrigin(request: IncomingMessage): string {
  const encrypted = "encrypted" in request.socket && request.socket.encrypted;
  try {
    return new URL(`${encrypted ? "https" : "http"}://${request.headers.host ?? "localhost"}`)
      .origin;
  } catch {
    return `${encrypted ? "https" : "http"}://localhost`;
  }
}

const a2aGatewayRoutePaths = [
  "/.well-known/agent-card.json",
  "/.well-known/agent.json",
  "/a2a/v1",
] as const;

const A2A_ACCOUNT_STATUS_FIELDS = ["unresolvedPeers", "unresolvedOutboundPeers"] as const;

function normalizeA2aChannelTarget(raw: string): string | undefined {
  const target = raw.trim().replace(/^a2a:/i, "");
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(target) ? target : undefined;
}

const a2aChannelMessageAdapter = defineChannelMessageAdapter({
  id: A2A_CHANNEL_ID,
  durableFinal: { capabilities: { text: true } },
  send: {
    text: async (ctx) => {
      const result = await sendA2aChannelText({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.text,
        assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
      });
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: A2A_CHANNEL_ID, messageId: result.messageId }],
          kind: "text",
        }),
      };
    },
  },
});

export const a2aChannelPlugin: ChannelPlugin<ResolvedA2aChannelAccount> = createChatChannelPlugin({
  base: {
    ...a2aChannelSetupPlugin,
    messaging: {
      transformReplyPayload: ({ payload }) =>
        isHostNoticePayload(payload) || !isReplyPayloadTerminalContent(payload) ? null : payload,
      normalizeTarget: normalizeA2aChannelTarget,
      inferTargetChatType: () => "direct",
      targetResolver: {
        looksLikeId: (raw) => normalizeA2aChannelTarget(raw) !== undefined,
        hint: "<a2a-peer-name>",
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const peerName = normalizeA2aChannelTarget(target);
        if (!peerName) {
          return null;
        }
        return buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: A2A_CHANNEL_ID,
          accountId,
          recipientSessionExact: true,
          peer: { kind: "direct", id: peerName },
          chatType: "direct",
          from: `${A2A_CHANNEL_ID}:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: peerName,
        });
      },
    },
    status: createComputedAccountStatusAdapter<ResolvedA2aChannelAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      /**
       * Surfaces peers that config loading left unusable because a `${VAR}` credential
       * reference did not resolve. Without this the only signal is one startup log line,
       * while the remote peer just sees a bare 401 or a refused send.
       */
      collectStatusIssues: (accounts) => {
        const issues: ChannelStatusIssue[] = [];
        for (const entry of accounts) {
          const account = readAccountStatusSnapshot(entry, A2A_ACCOUNT_STATUS_FIELDS);
          if (!account) {
            continue;
          }
          // A fully withheld channel reports configured=false, so only enabled accounts are skipped here.
          const accountId = resolveEnabledConfiguredAccountId(account) ?? account.accountId;
          if (account.enabled === false || typeof accountId !== "string" || !accountId) {
            continue;
          }
          const inbound = filterStringEntries(account.unresolvedPeers).filter(Boolean);
          if (inbound.length > 0) {
            issues.push({
              channel: "a2a",
              accountId,
              kind: "config",
              message: `A2A peer${inbound.length === 1 ? "" : "s"} ${inbound.join(", ")} cannot authenticate: the inbound token reference did not resolve, so requests from ${inbound.length === 1 ? "it are" : "them are"} rejected with 401.`,
              fix: `Set the environment variable referenced by channels.a2a.peers.<name>.token for ${inbound.join(", ")}, then reload or restart the gateway.`,
            });
          }
          const outbound = filterStringEntries(account.unresolvedOutboundPeers).filter(Boolean);
          if (outbound.length > 0) {
            issues.push({
              channel: "a2a",
              accountId,
              kind: "config",
              message: `Sends to A2A peer${outbound.length === 1 ? "" : "s"} ${outbound.join(", ")} are refused: the outbound token reference did not resolve.`,
              fix: `Set the environment variable referenced by channels.a2a.peers.<name>.outboundToken for ${outbound.join(", ")}, then reload or restart the gateway.`,
            });
          }
        }
        return issues;
      },
      buildChannelSummary: ({ snapshot }) => ({
        configured: snapshot.configured ?? false,
        running: snapshot.running ?? false,
      }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          peerCount: Object.keys(account.config.peers ?? {}).length,
          // Names only: these peers stay unavailable until their token variable is set.
          ...(account.unresolvedPeers.length > 0
            ? { unresolvedPeers: account.unresolvedPeers }
            : {}),
          ...(account.unresolvedOutboundPeers.length > 0
            ? { unresolvedOutboundPeers: account.unresolvedOutboundPeers }
            : {}),
        },
      }),
    }),
    gateway: {
      startAccount: async (ctx) => {
        const { account } = ctx;
        const config = ctx.cfg;
        if (!account.configured) {
          throw new Error(`A2A channel is not configured for account "${account.accountId}"`);
        }

        ctx.setStatus({
          accountId: account.accountId,
          running: true,
          lifecycle: "starting",
          configured: true,
          enabled: account.enabled,
        });

        const runtime = getA2aChannelRuntime();
        const a2aConfig = account.config;
        const version = runtime.version;
        // SAFETY: Gateway injects its full runtime despite the narrowed public contract.
        const channelRuntime = (ctx.channelRuntime ?? runtime.channel) as PluginRuntime["channel"];
        const store = new A2aTaskStore();
        const unregisterRoutes: Array<() => void> = [];
        function createAgentCard(request: IncomingMessage) {
          // listAgentIds reads both the canonical `agents.entries` roster and the legacy
          // `agents.list` projection; reading either shape directly publishes a
          // skill-less card to every peer whose operator configured the other one.
          const exposed = a2aConfig.exposeAgents;
          const agentIds = listAgentIds(config).filter(
            (agentId) => !exposed?.length || exposed.includes(agentId),
          );
          const instanceName =
            (agentIds[0] ? resolveAgentConfig(config, agentIds[0])?.name?.trim() : undefined) ||
            "OpenClaw";
          const advertisedOrigin = a2aConfig.advertisedUrl ?? resolveRequestOrigin(request);
          return {
            name: instanceName,
            description: "OpenClaw agent gateway using the Agent2Agent protocol.",
            supportedInterfaces: [
              {
                url: `${advertisedOrigin.replace(/\/+$/, "")}/a2a/v1`,
                protocolBinding: "JSONRPC",
                protocolVersion: "1.0",
              },
            ],
            version,
            capabilities: {
              streaming: false,
              pushNotifications: false,
            },
            defaultInputModes: ["text/plain"],
            defaultOutputModes: ["text/plain"],
            // AgentSkill.description is spec-required. Operator-authored agent
            // descriptions are deliberately not published here: the card is served
            // unauthenticated, so only the agent id crosses the discovery boundary.
            skills: agentIds.map((agentId) => ({
              id: agentId,
              name: agentId,
              description: `OpenClaw agent ${agentId}.`,
              tags: ["openclaw"],
            })),
          };
        }

        try {
          const peerRequestTimes = new Map<string, number[]>();

          function isRateLimited(peerName: string): boolean {
            const maximum = a2aConfig.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
            if (maximum === 0) {
              return false;
            }
            const now = Date.now();
            const requests = (peerRequestTimes.get(peerName) ?? []).filter(
              (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
            );
            if (requests.length >= maximum) {
              peerRequestTimes.set(peerName, requests);
              return true;
            }
            requests.push(now);
            peerRequestTimes.set(peerName, requests);
            return false;
          }

          async function processRpcRequest(
            input: unknown,
            peerName: string,
          ): Promise<A2aRpcResponse | undefined> {
            const parsed = A2aRpcRequestSchema.safeParse(input);
            const candidateId = isRecord(input) ? input.id : undefined;
            const id =
              typeof candidateId === "string" || typeof candidateId === "number"
                ? candidateId
                : null;
            const notification = parsed.success && !Object.hasOwn(parsed.data, "id");

            if (isRateLimited(peerName)) {
              return notification ? undefined : createRpcError(id, -32000, "Peer is rate limited");
            }

            if (!parsed.success) {
              return createRpcError(id, -32600, "Invalid JSON-RPC request");
            }

            const request = parsed.data;

            let result: unknown;
            try {
              const method = resolveA2aRpcMethod(request.method);
              if (method === undefined) {
                throw new A2aProtocolError(-32601, `Method not found: ${request.method}`);
              }
              if (method === "unsupported") {
                throw new A2aProtocolError(
                  -32004,
                  "Unsupported operation; supported methods are SendMessage and GetTask",
                );
              }

              if (method === "SendMessage") {
                const send = A2aSendMessageParamsSchema.safeParse(request.params);
                if (!send.success) {
                  throw new A2aProtocolError(
                    -32602,
                    "Invalid SendMessage params: message and parts required",
                  );
                }
                const message = send.data.message;
                const text = extractA2aMessageText(message.parts);
                if (!text) {
                  throw new A2aProtocolError(
                    -32602,
                    "Message must contain at least one usable text part",
                  );
                }
                if (message.taskId !== undefined) {
                  const referencedTask = store.get(message.taskId, peerName);
                  if (!referencedTask) {
                    throw new A2aProtocolError(-32001, "Task not found");
                  }
                  if (
                    message.contextId !== undefined &&
                    message.contextId !== referencedTask.contextId
                  ) {
                    throw new A2aProtocolError(
                      -32602,
                      "Message contextId does not match the referenced task",
                    );
                  }
                  // A context-only follow-up starts new work; a task reference must never
                  // silently allocate a replacement for an active or terminal task.
                  throw new A2aProtocolError(
                    -32004,
                    "Task continuation is not supported; omit taskId and reuse contextId to start a new task",
                  );
                }
                const messageId = message.messageId ?? randomUUID();
                const task = store.create(
                  message.contextId ?? `ctx-${randomUUID()}`,
                  peerName,
                  messageId,
                );
                if (store.start(task.id)) {
                  // Reserve detached work before the HTTP request releases its admission root.
                  void runDetachedWebhookWork(async () => {
                    await dispatchA2aInbound({
                      account,
                      config,
                      channelRuntime,
                      store,
                      taskId: task.id,
                      contextId: task.contextId,
                      messageId,
                      peerName,
                      text,
                    });
                  }).catch((error: unknown) => store.fail(task.id, error));
                }

                if (!send.data.configuration?.returnImmediately) {
                  const timeoutMs = a2aConfig.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;
                  await store.wait(task, timeoutMs);
                }
                result = { task };
              } else {
                const taskParams = A2aTaskRequestParamsSchema.safeParse(request.params);
                if (!taskParams.success) {
                  throw new A2aProtocolError(-32602, "Invalid task params: id is required");
                }
                const task = store.get(taskParams.data.id, peerName);
                if (!task) {
                  throw new A2aProtocolError(-32001, "Task not found");
                }
                result = task;
              }
            } catch (error) {
              if (notification) {
                return undefined;
              }
              if (error instanceof A2aProtocolError) {
                return createRpcError(id, error.code, error.message);
              }
              return createRpcError(id, -32000, "A2A request could not be processed");
            }

            return notification ? undefined : { jsonrpc: "2.0", id, result };
          }

          const handler = async (
            request: IncomingMessage,
            response: ServerResponse,
          ): Promise<boolean> => {
            const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
            if (
              request.method === "GET" &&
              (pathname === "/.well-known/agent-card.json" ||
                pathname === "/.well-known/agent.json")
            ) {
              writeJsonResponse(response, 200, createAgentCard(request));
              return true;
            }

            if (request.method !== "POST" || pathname !== "/a2a/v1") {
              writeJsonResponse(response, 404, { error: "Not found" });
              return true;
            }

            const peerName = resolvePeerName(request, a2aConfig);
            if (!peerName) {
              writeJsonResponse(response, 401, {
                error: "Unauthorized; configure channels.a2a.peers with a matching Bearer token",
              });
              return true;
            }

            let body: string;
            try {
              body = await readRequestBodyWithLimit(request, {
                maxBytes: MAX_REQUEST_BODY_BYTES,
                // Defer destruction so the rejection below reaches the peer before the close.
                destroyOnLimit: false,
              });
            } catch (error) {
              const bodyRejection = isRequestBodyLimitError(error, "PAYLOAD_TOO_LARGE")
                ? { statusCode: 413, body: { error: "Request body exceeds the 1 MiB limit" } }
                : isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")
                  ? {
                      statusCode: 200,
                      body: createRpcError(null, -32000, "Request body could not be read"),
                    }
                  : undefined;
              if (bodyRejection) {
                response.setHeader("cache-control", "no-store");
                await sendHttpRequestRejection(
                  request,
                  response,
                  bodyRejection.statusCode,
                  JSON.stringify(bodyRejection.body),
                  "application/json; charset=utf-8",
                );
                return true;
              }
              writeJsonResponse(
                response,
                200,
                createRpcError(null, -32000, "Request body could not be read"),
              );
              return true;
            }

            let payload: unknown;
            try {
              payload = JSON.parse(body);
            } catch {
              writeJsonResponse(response, 200, createRpcError(null, -32700, "Parse error"));
              return true;
            }

            let result: A2aRpcResponse | A2aRpcResponse[] | undefined;
            if (Array.isArray(payload)) {
              if (payload.length === 0) {
                writeJsonResponse(
                  response,
                  200,
                  createRpcError(null, -32600, "Invalid JSON-RPC request"),
                );
                return true;
              }
              if (payload.length > MAX_BATCH_REQUESTS) {
                const error = isRateLimited(peerName)
                  ? createRpcError(null, -32000, "Peer is rate limited")
                  : createRpcError(
                      null,
                      -32000,
                      `A2A batch exceeds the ${MAX_BATCH_REQUESTS} request limit`,
                    );
                writeRpcResponse(response, error);
                return true;
              }
              const responses = (
                await Promise.all(payload.map((entry) => processRpcRequest(entry, peerName)))
              ).filter((entry): entry is A2aRpcResponse => entry !== undefined);
              result = responses.length > 0 ? responses : undefined;
            } else {
              result = await processRpcRequest(payload, peerName);
            }
            if (result) {
              writeRpcResponse(response, result);
            } else {
              response.statusCode = 200;
              response.end();
            }
            return true;
          };

          for (const routePath of a2aGatewayRoutePaths) {
            unregisterRoutes.push(
              // A2A owns fixed global paths on a single account, so a duplicate
              // registration means a stale or conflicting owner. Fail loudly instead
              // of replacing a live handler (GHSA-RQP8-Q22P-5J9Q).
              registerPluginHttpRoute({
                path: routePath,
                auth: "plugin",
                match: "exact",
                pluginId: "a2a",
                source: "a2a-gateway",
                accountId: account.accountId,
                throwOnFailure: true,
                handler,
              }),
            );
          }

          ctx.setStatus(channelReadyPatch({ accountId: account.accountId }));
          await waitUntilAbort(ctx.abortSignal);
        } finally {
          // Stop admission before releasing blocked responses; otherwise shutdown can
          // admit a task after its lifecycle-owned waiters and timers were cleared.
          for (const unregister of unregisterRoutes.toReversed()) {
            unregister();
          }
          store.stop();
          ctx.setStatus(channelStoppedPatch({ accountId: account.accountId }));
        }
      },
    },
    message: a2aChannelMessageAdapter,
  },
  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: A2A_CHANNEL_ID,
      sendText: sendA2aChannelText,
    },
  },
});
