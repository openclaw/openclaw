// Authored by: cc (Claude Code) | 2026-03-19
import { Type } from "@sinclair/typebox";
import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { SmsConfigSchema, resolveSmsConfig, type SmsConfigInput } from "./src/config.js";
import { createSmsRuntime, type SmsRuntime } from "./src/runtime.js";

const smsPlugin = {
  id: "twilio-sms",
  name: "Twilio SMS",
  description:
    "Receive inbound SMS via Twilio and route messages to the OC agent (Phase 1: inbound only)",

  register(api: OpenClawPluginApi) {
    const config = SmsConfigSchema.parse(
      resolveSmsConfig((api.pluginConfig ?? {}) as SmsConfigInput),
    );
    let runtime: SmsRuntime | null = null;

    api.registerService({
      id: "twilio-sms",
      start: async () => {
        runtime = await createSmsRuntime(config, api.runtime.subagent, api.logger);
      },
      stop: async () => {
        await runtime?.stop();
        runtime = null;
      },
    });

    api.registerGatewayMethod("sms.status", ({ respond }: GatewayRequestHandlerOptions) => {
      respond(true, { running: !!runtime, port: config.serve.port });
    });

    api.registerTool({
      name: "sms_inbox",
      label: "SMS Inbox",
      description:
        "View recent inbound SMS messages received at the configured Twilio number. Returns up to 50 messages.",
      parameters: Type.Object({}),
      async execute(_toolCallId: string) {
        const messages = runtime?.getInbox() ?? [];
        return {
          content: [{ type: "text" as const, text: JSON.stringify(messages, null, 2) }],
          details: { messages },
        };
      },
    });
  },
};

export default smsPlugin;
