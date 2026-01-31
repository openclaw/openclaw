/**
 * OpenClaw extension entry point for the voiceNode bridge.
 *
 * Registers:
 * - A service that starts/stops the WebSocket bridge server
 * - A gateway method "voicenode.status" for health checks
 * - An HTTP route /voicenode/status for REST access
 * - A gateway dispatcher so chat.request messages reach the OpenClaw agent
 * - A voicenode_tool proxy so the agent can invoke voiceNode's tools
 */

import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";

import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import type { MsgContext } from "../../src/auto-reply/templating.js";
import { dispatchInboundMessageWithDispatcher } from "../../src/auto-reply/dispatch.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../src/utils/message-channel.js";

import { BridgeServer } from "./src/bridge-server.js";
import { loadConfig } from "./src/config.js";

let bridge: BridgeServer | null = null;

/**
 * Build a GatewayDispatcher that routes chat messages into OpenClaw's
 * agent pipeline via dispatchInboundMessageWithDispatcher.
 */
function createGatewayDispatcher(
  cfg: OpenClawConfig,
  logger: { info: Function; warn: Function; error: Function },
) {
  return {
    sendChat: async (
      sessionKey: string,
      message: string,
    ): Promise<{ content: string; metadata?: Record<string, unknown> }> => {
      const runId = crypto.randomUUID();

      const ctx: MsgContext = {
        Body: message,
        BodyForAgent: message,
        BodyForCommands: message,
        RawBody: message,
        CommandBody: message,
        SessionKey: sessionKey,
        Provider: INTERNAL_MESSAGE_CHANNEL,
        Surface: INTERNAL_MESSAGE_CHANNEL,
        OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
        ChatType: "direct",
        CommandAuthorized: true,
        MessageSid: runId,
      };

      const finalParts: string[] = [];

      await dispatchInboundMessageWithDispatcher({
        ctx,
        cfg,
        dispatcherOptions: {
          deliver: async (payload, info) => {
            if (info.kind !== "final") return;
            const text = payload.text?.trim() ?? "";
            if (text) finalParts.push(text);
          },
          onError: (err) => {
            logger.error(`[voicenode-bridge] dispatch error: ${err}`);
          },
        },
      });

      return { content: finalParts.join("\n\n").trim() };
    },
  };
}

const plugin = {
  id: "voicenode-bridge",
  name: "voiceNode Bridge",
  description:
    "Bilateral WebSocket bridge for voiceNode tool execution and chat",

  register(api: OpenClawPluginApi) {
    const config = loadConfig(api.pluginConfig ?? {});

    if (!config.enabled) {
      api.logger.info("[voicenode-bridge] disabled");
      return;
    }

    if (!config.token) {
      api.logger.warn(
        "[voicenode-bridge] enabled but no token configured — skipping",
      );
      return;
    }

    // Build gateway dispatcher so chat.request messages reach the agent
    const gateway = createGatewayDispatcher(
      api.config as OpenClawConfig,
      api.logger,
    );

    bridge = new BridgeServer({
      config,
      logger: api.logger,
      gateway,
    });

    // Register as a lifecycle service (started/stopped with the gateway)
    api.registerService({
      id: "voicenode-bridge",
      start: async () => {
        await bridge!.start();
      },
      stop: async () => {
        await bridge!.stop();
      },
    });

    // Register a gateway RPC method for status checks
    api.registerGatewayMethod(
      "voicenode.status",
      async ({ respond }) => {
        respond(true, {
          connected: bridge?.isClientConnected() ?? false,
          port: config.port,
        });
      },
    );

    // Register an HTTP route for REST status checks
    api.registerHttpRoute({
      path: "/voicenode/status",
      handler: async (_req, res) => {
        res.json({
          connected: bridge?.isClientConnected() ?? false,
          port: config.port,
        });
      },
    });

    // ── Register voicenode_tool proxy ────────────────────────────────
    // Allows the OpenClaw agent to invoke any of voiceNode's 135+ tools
    api.registerTool({
      name: "voicenode_tool",
      label: "voiceNode Tool Proxy",
      description: `Execute a tool on the connected voiceNode platform.
Available tool categories: ${config.allowedTools.join(", ")}.
Common tools include: sms_send, hubspot_create_contact, hubspot_search_contacts,
stripe_create_payment_link, salesforce_search, apollo_search_contacts,
shopify_get_orders, quickbooks_get_invoices, email_send, slack_send_message,
copywriter_create_content, document_generate_pdf, etc.
Pass the exact tool name and its arguments.`,
      parameters: Type.Object({
        tool_name: Type.String({
          description:
            "The voiceNode tool name (e.g. hubspot_create_contact, sms_send)",
        }),
        arguments: Type.Record(Type.String(), Type.Unknown(), {
          description: "Tool arguments as key-value pairs",
        }),
        tenant_id: Type.Optional(
          Type.String({ description: "Tenant ID (defaults to 'default')" }),
        ),
        user_id: Type.Optional(
          Type.String({ description: "User ID (defaults to 'system')" }),
        ),
      }),
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(payload, null, 2),
            },
          ],
          details: payload,
        });

        if (!bridge?.isClientConnected()) {
          return json({ error: "voiceNode client not connected" });
        }

        if (!bridge.isToolAllowed(params.tool_name)) {
          return json({
            error: `Tool "${params.tool_name}" is not in the allowed tools list`,
          });
        }

        try {
          const result = await bridge.callVoiceNodeTool(
            params.tool_name,
            params.arguments ?? {},
            {
              tenantId: params.tenant_id || "default",
              userId: params.user_id || "system",
            },
          );
          return json({ success: true, data: result });
        } catch (err) {
          return json({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });

    api.logger.info(
      `[voicenode-bridge] registered (port=${config.port}, tool=voicenode_tool)`,
    );
  },
};

export default plugin;

/**
 * Get the bridge server instance (for use by other extensions).
 */
export function getBridgeServer(): BridgeServer | null {
  return bridge;
}
