/**
 * @openclaw/missed-call-sms — plugin entry point.
 *
 * Wires up the runtime, gateway methods, and tool surface for the
 * Missed-Call-to-SMS service template. The runtime itself lives in
 * src/runtime.ts and is created lazily on first use.
 */

import { Type } from "@sinclair/typebox";
import type {
  GatewayRequestHandlerOptions,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/voice-call";
import {
  MissedCallSmsConfigSchema,
  validateProviderConfig,
  type MissedCallSmsConfig,
} from "./src/config.js";
import { createMissedCallSmsRuntime, type MissedCallSmsRuntime } from "./src/runtime.js";

const configSchema = {
  parse(value: unknown): MissedCallSmsConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return MissedCallSmsConfigSchema.parse(raw);
  },
};

// Tool surface for the Mission Control agent + Ultron. Lets an agent list
// open conversations, read transcripts, send a manual reply, or take over
// a thread (which silences the autonomous agent on that conversation).
const MissedCallSmsToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("list_conversations"),
    status: Type.Optional(
      Type.Union([
        Type.Literal("open"),
        Type.Literal("escalated"),
        Type.Literal("closed"),
        Type.Literal("all"),
      ]),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  }),
  Type.Object({
    action: Type.Literal("get_conversation"),
    conversationId: Type.String({ description: "Conversation ID" }),
  }),
  Type.Object({
    action: Type.Literal("send_reply"),
    conversationId: Type.String({ description: "Conversation ID" }),
    message: Type.String({ description: "SMS body to send to the caller" }),
  }),
  Type.Object({
    action: Type.Literal("take_over"),
    conversationId: Type.String({ description: "Conversation ID" }),
  }),
  Type.Object({
    action: Type.Literal("close"),
    conversationId: Type.String({ description: "Conversation ID" }),
  }),
]);

const missedCallSmsPlugin = {
  id: "missed-call-sms",
  name: "Missed Call → SMS",
  description:
    "Catches missed calls, captures voicemail, and runs an AI-driven SMS conversation with the caller.",
  configSchema,
  register(api: OpenClawPluginApi) {
    const config = configSchema.parse(api.pluginConfig);
    const validation = validateProviderConfig(config);

    let runtimePromise: Promise<MissedCallSmsRuntime> | null = null;
    let runtime: MissedCallSmsRuntime | null = null;

    const ensureRuntime = async (): Promise<MissedCallSmsRuntime> => {
      if (!config.enabled) {
        throw new Error("missed-call-sms is disabled in plugin config");
      }
      if (!validation.valid) {
        throw new Error(
          `missed-call-sms misconfigured: ${validation.errors.join("; ")}`,
        );
      }
      if (runtime) return runtime;
      if (!runtimePromise) {
        runtimePromise = createMissedCallSmsRuntime({
          config,
          logger: api.logger,
        });
      }
      try {
        runtime = await runtimePromise;
      } catch (err) {
        // Reset the cached promise so the next call retries cleanly,
        // matching the voice-call plugin pattern.
        runtimePromise = null;
        throw err;
      }
      return runtime;
    };

    const sendError = (
      respond: (ok: boolean, payload?: unknown) => void,
      err: unknown,
    ) => {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    };

    // ---- Gateway methods (consumed by Mission Control + Ultron) ----

    api.registerGatewayMethod(
      "missedcall.list",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const status =
            typeof params?.status === "string" ? params.status : "open";
          const limit =
            typeof params?.limit === "number" ? params.limit : 50;
          const items = await rt.store.listConversations({ status, limit });
          respond(true, { items });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "missedcall.get",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const id =
            typeof params?.conversationId === "string"
              ? params.conversationId.trim()
              : "";
          if (!id) {
            respond(false, { error: "conversationId required" });
            return;
          }
          const rt = await ensureRuntime();
          const convo = await rt.store.getConversation(id);
          if (!convo) {
            respond(true, { found: false });
            return;
          }
          respond(true, { found: true, conversation: convo });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "missedcall.reply",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const id =
            typeof params?.conversationId === "string"
              ? params.conversationId.trim()
              : "";
          const message =
            typeof params?.message === "string" ? params.message.trim() : "";
          if (!id || !message) {
            respond(false, { error: "conversationId and message required" });
            return;
          }
          const rt = await ensureRuntime();
          const result = await rt.sendManualReply(id, message);
          respond(result.success, result);
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "missedcall.takeover",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const id =
            typeof params?.conversationId === "string"
              ? params.conversationId.trim()
              : "";
          if (!id) {
            respond(false, { error: "conversationId required" });
            return;
          }
          const rt = await ensureRuntime();
          await rt.store.setStatus(id, "human-takeover");
          respond(true, { success: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "missedcall.close",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const id =
            typeof params?.conversationId === "string"
              ? params.conversationId.trim()
              : "";
          if (!id) {
            respond(false, { error: "conversationId required" });
            return;
          }
          const rt = await ensureRuntime();
          await rt.store.setStatus(id, "closed");
          respond(true, { success: true });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    // ---- Agent tool ----

    api.registerTool({
      name: "missed_call_sms",
      label: "Missed Call SMS",
      description:
        "Inspect and manage missed-call-to-SMS conversations driven by the AI receptionist.",
      parameters: MissedCallSmsToolSchema,
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [
            { type: "text" as const, text: JSON.stringify(payload, null, 2) },
          ],
          details: payload,
        });
        try {
          const rt = await ensureRuntime();
          switch (params.action) {
            case "list_conversations": {
              const items = await rt.store.listConversations({
                status: params.status ?? "open",
                limit: params.limit ?? 25,
              });
              return json({ items });
            }
            case "get_conversation": {
              const convo = await rt.store.getConversation(params.conversationId);
              return json(convo ? { found: true, conversation: convo } : { found: false });
            }
            case "send_reply": {
              const r = await rt.sendManualReply(
                params.conversationId,
                params.message,
              );
              return json(r);
            }
            case "take_over": {
              await rt.store.setStatus(params.conversationId, "human-takeover");
              return json({ success: true });
            }
            case "close": {
              await rt.store.setStatus(params.conversationId, "closed");
              return json({ success: true });
            }
          }
          return json({ error: "unknown action" });
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    // ---- Service lifecycle ----

    api.registerService({
      id: "missed-call-sms",
      start: async () => {
        if (!config.enabled) return;
        if (!validation.valid) {
          api.logger.warn(
            `[missed-call-sms] disabled (config incomplete): ${validation.errors.join("; ")}`,
          );
          return;
        }
        try {
          await ensureRuntime();
          api.logger.info(
            `[missed-call-sms] runtime started — webhook ${config.publicUrl ?? `http://${config.webhook.bind}:${config.webhook.port}${config.webhook.path}`}`,
          );
        } catch (err) {
          api.logger.error(
            `[missed-call-sms] failed to start: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      stop: async () => {
        if (!runtimePromise) return;
        try {
          const rt = await runtimePromise;
          await rt.stop();
        } finally {
          runtimePromise = null;
          runtime = null;
        }
      },
    });
  },
};

export default missedCallSmsPlugin;
