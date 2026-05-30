import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { PluginRuntime } from "../api.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { collectHeadersFromRecord } from "./auth.js";
import {
  handleWebhookEnvelope,
  type ScheduleSessionTurn,
  type WebhookAgentCompletionDispatch,
} from "./http.js";
import { createInMemoryIdempotencyRecords } from "./idempotency.js";
import { signWebhookTestPayload, type WebhookSubscriptionStore } from "./subscriptions.js";

type Logger = {
  warn?: (message: string, details?: unknown) => void;
};

type GatewayErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

function respondError(
  respond: GatewayRequestHandlerOptions["respond"],
  message: string,
  code: GatewayErrorCode = ErrorCodes.INVALID_REQUEST,
): void {
  respond(false, undefined, errorShape(code, message));
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (typeof value === "string") {
    const parsed = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return parsed.length ? parsed : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parsed = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return parsed.length ? parsed : undefined;
}

function readPositiveNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readDeliveryMode(params: Record<string, unknown>): "announce" | "none" | undefined {
  return params.deliveryMode === "announce" || params.deliveryMode === "none"
    ? params.deliveryMode
    : undefined;
}

function readDispatchMode(params: Record<string, unknown>): "ack" | "agent" | undefined {
  return params.dispatchMode === "ack" || params.dispatchMode === "agent"
    ? params.dispatchMode
    : undefined;
}

function readTestPayload(params: Record<string, unknown>): string {
  const payload = params.payload;
  if (typeof payload === "string" && payload.trim()) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    return JSON.stringify(payload);
  }
  return "{}";
}

export function registerWebhooksGatewayMethods(params: {
  api: {
    registerGatewayMethod: (
      method: string,
      handler: (opts: GatewayRequestHandlerOptions) => Promise<void> | void,
      opts?: { scope?: "operator.read" | "operator.write" },
    ) => void;
  };
  cfg: OpenClawConfig;
  store: WebhookSubscriptionStore;
  scheduleSessionTurn?: ScheduleSessionTurn;
  onAgentCompletionDispatch?: (dispatch: WebhookAgentCompletionDispatch) => void | Promise<void>;
  loadChannelOutboundAdapter?: PluginRuntime["channel"]["outbound"]["loadAdapter"];
  logger?: Logger;
}): void {
  params.api.registerGatewayMethod(
    "webhooks.subscribe",
    async ({ params: requestParams, respond }) => {
      try {
        const name = readString(requestParams, "name");
        if (!name) {
          respondError(respond, "name required");
          return;
        }
        const result = await params.store.subscribe({
          name,
          path: readString(requestParams, "path"),
          sessionKey: readString(requestParams, "sessionKey"),
          secret: readString(requestParams, "secret"),
          events: readStringArray(requestParams, "events"),
          eventHeader: readString(requestParams, "eventHeader"),
          eventPayloadPath: readString(requestParams, "eventPayloadPath"),
          idempotencyHeader: readString(requestParams, "idempotencyHeader"),
          idempotencyPayloadPath: readString(requestParams, "idempotencyPayloadPath"),
          idempotencyTtlHours: readPositiveNumber(requestParams, "idempotencyTtlHours"),
          dispatchMode: readDispatchMode(requestParams),
          agentId: readString(requestParams, "agentId"),
          deliveryMode: readDeliveryMode(requestParams),
          prompt: readString(requestParams, "prompt"),
          messageTemplate: readString(requestParams, "messageTemplate"),
          skills: readStringArray(requestParams, "skills"),
          description: readString(requestParams, "description"),
        });
        respond(true, result);
      } catch (err) {
        respondError(respond, err instanceof Error ? err.message : String(err));
      }
    },
    { scope: "operator.write" },
  );

  params.api.registerGatewayMethod(
    "webhooks.list",
    async ({ respond }) => {
      try {
        respond(true, { subscriptions: await params.store.list() });
      } catch (err) {
        respondError(respond, err instanceof Error ? err.message : String(err));
      }
    },
    { scope: "operator.read" },
  );

  params.api.registerGatewayMethod(
    "webhooks.remove",
    async ({ params: requestParams, respond }) => {
      try {
        const name = readString(requestParams, "name");
        if (!name) {
          respondError(respond, "name required");
          return;
        }
        respond(true, { removed: await params.store.remove(name) });
      } catch (err) {
        respondError(respond, err instanceof Error ? err.message : String(err));
      }
    },
    { scope: "operator.write" },
  );

  params.api.registerGatewayMethod(
    "webhooks.test",
    async ({ params: requestParams, respond }) => {
      try {
        const name = readString(requestParams, "name");
        if (!name) {
          respondError(respond, "name required");
          return;
        }
        const subscription = await params.store.get(name);
        if (!subscription) {
          respondError(respond, `subscription not found: ${name}`);
          return;
        }
        const rawBody = readTestPayload(requestParams);
        const signature = signWebhookTestPayload(rawBody, subscription.auth.secret);
        const targetsByPath = await params.store.loadTargets();
        const targets = targetsByPath.get(subscription.path);
        if (!targets?.length) {
          respondError(
            respond,
            `subscription route is not active: ${name}`,
            ErrorCodes.UNAVAILABLE,
          );
          return;
        }
        const result = await handleWebhookEnvelope({
          cfg: params.cfg,
          targets,
          envelope: {
            path: subscription.path,
            headers: collectHeadersFromRecord({
              "content-type": "application/json",
              [subscription.auth.header]: `${subscription.auth.prefix}${signature}`,
              ...(readString(requestParams, "eventType") && subscription.event?.header
                ? { [subscription.event.header]: readString(requestParams, "eventType") }
                : {}),
              ...(readString(requestParams, "idempotencyKey") && subscription.idempotency?.header
                ? { [subscription.idempotency.header]: readString(requestParams, "idempotencyKey") }
                : {}),
            }),
            rawBody,
          },
          idempotencyRecords: createInMemoryIdempotencyRecords(),
          scheduleSessionTurn: params.scheduleSessionTurn,
          onAgentCompletionDispatch: params.onAgentCompletionDispatch,
          loadChannelOutboundAdapter: params.loadChannelOutboundAdapter,
          logger: params.logger,
        });
        respond(true, { result });
      } catch (err) {
        respondError(respond, err instanceof Error ? err.message : String(err));
      }
    },
    { scope: "operator.write" },
  );
}
