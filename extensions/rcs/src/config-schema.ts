// Rcs helper module supports config schema behavior.
import {
  AllowFromListSchema,
  buildChannelConfigSchema,
  DmPolicySchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const SecretInputSchema = buildSecretInputSchema();

const RcsAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    accountSid: z.string().optional(),
    authToken: SecretInputSchema.optional(),
    messagingServiceSid: z.string().optional(),
    senderId: z.string().optional(),
    transport: z.enum(["rcs-only", "rcs-preferred"]).optional(),
    defaultTo: z.string().optional(),
    webhookPath: z.string().optional(),
    publicWebhookUrl: z.string().optional(),
    sharedWebhookPath: z.string().optional(),
    sharedWebhookPublicUrl: z.string().optional(),
    smsForwardWebhookPath: z.string().optional(),
    statusCallbacks: z.boolean().optional(),
    dangerouslyDisableSignatureValidation: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: AllowFromListSchema,
    textChunkLimit: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireChannelOpenAllowFrom({
      channel: "rcs",
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      requireOpenAllowFrom,
    });
  });

const RcsConfigSchema = RcsAccountConfigSchema.extend({
  accounts: z.record(z.string(), RcsAccountConfigSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
});

export const RcsChannelConfigSchema = buildChannelConfigSchema(RcsConfigSchema, {
  uiHints: {
    "": {
      label: "RCS",
      help: "Twilio RCS Business Messaging channel configuration for inbound webhooks and outbound rich replies.",
    },
    accountSid: {
      label: "Twilio Account SID",
      help: "Twilio Account SID used for RCS outbound API calls.",
    },
    authToken: {
      label: "Twilio Auth Token",
      help: "Twilio Auth Token used to sign webhook validation and RCS outbound API calls.",
    },
    messagingServiceSid: {
      label: "Twilio Messaging Service SID",
      help: "Messaging Service whose sender pool contains the approved RCS Sender.",
    },
    senderId: {
      label: "RCS Sender ID",
      help: 'Optional Twilio RCS Sender agent id, for example "rcs:myagent_abc123_agent". Used as From for direct sends without a Messaging Service.',
    },
    transport: {
      label: "RCS Transport Mode",
      help: '"rcs-only" (default) targets rcs:+E164 with no SMS fallback; "rcs-preferred" lets Twilio fall back to SMS/MMS when RCS cannot deliver.',
    },
    defaultTo: {
      label: "RCS Default To Number",
      help: "Optional default outbound phone number used when a send flow omits an explicit RCS target.",
    },
    publicWebhookUrl: {
      label: "RCS Public Webhook URL",
      help: "Public URL configured in Twilio for incoming messages. Must match Twilio's signed URL exactly.",
    },
    webhookPath: {
      label: "RCS Webhook Path",
      help: "Gateway HTTP path that receives Twilio incoming-message webhooks. Use a distinct path per account.",
    },
    sharedWebhookPath: {
      label: "Shared Twilio Webhook Path",
      help: "Optional public SMS/RCS Twilio webhook path used when an existing Messaging Service posts both SMS and RCS to the same URL.",
    },
    sharedWebhookPublicUrl: {
      label: "Shared Twilio Public Webhook URL",
      help: "Public URL Twilio signs for the shared SMS/RCS webhook path. Used only by the shared webhook router.",
    },
    smsForwardWebhookPath: {
      label: "SMS Forward Webhook Path",
      help: "Internal Gateway path for non-RCS payloads forwarded by the shared webhook router.",
    },
    statusCallbacks: {
      label: "RCS Status Callbacks",
      help: "Request Twilio delivery/read status callbacks for outbound RCS messages (requires publicWebhookUrl).",
    },
    dmPolicy: {
      label: "RCS DM Policy",
      help: 'Direct RCS access control ("pairing" recommended). "open" requires channels.rcs.allowFrom=["*"].',
    },
    allowFrom: {
      label: "RCS Allow From",
      help: "Allowed sender phone numbers in E.164 format, or * when dmPolicy is open.",
    },
    textChunkLimit: {
      label: "RCS Text Chunk Limit",
      help: "Maximum characters per outbound RCS chunk before OpenClaw splits long replies (capped at Twilio's 1,600-character message body limit).",
    },
  },
});
