const dmSchema = {
  type: "object",
  properties: {
    policy: { type: "string", enum: ["pairing", "allowlist", "open", "disabled"] },
    allowFrom: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

const routingSchema = {
  type: "object",
  properties: {
    pairedAgent: { type: "string" },
    unpairedAgent: { type: "string" },
  },
  additionalProperties: false,
};

const outboundSchema = {
  type: "object",
  properties: {
    retryTimes: { type: "number" },
    retryCount: { type: "number" },
    retries: { type: "number" },
    retryDelayMs: { type: "number" },
    retryDelay: { type: "number" },
  },
  additionalProperties: false,
};

const voiceTranscribeSchema = {
  type: "object",
  properties: {
    endpoint: { type: "string" },
  },
  additionalProperties: false,
};

const menuItemSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    type: { type: "string", enum: ["click", "view"] },
    key: { type: "string" },
    url: { type: "string" },
  },
  required: ["name", "type"],
  additionalProperties: false,
};

const featuresSchema = {
  type: "object",
  properties: {
    menu: {
      type: "object",
      properties: { enabled: { type: "boolean" }, items: { type: "array", items: menuItemSchema } },
      additionalProperties: false,
    },
    assistantToggle: {
      type: "object",
      properties: { enabled: { type: "boolean" }, defaultEnabled: { type: "boolean" } },
      additionalProperties: false,
    },
    usageLimit: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        dailyMessages: { type: "number" },
        dailyTokens: { type: "number" },
        exemptPaired: { type: "boolean" },
      },
      additionalProperties: false,
    },
    routeGuard: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        unpairedAllowedAgents: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    handoff: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        contact: { type: "string" },
        message: { type: "string" },
        autoResumeMinutes: { type: "number" },
        activeReply: { type: "string" },
        ticketWebhook: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            endpoint: { type: "string" },
            token: { type: "string" },
            events: {
              type: "array",
              items: { type: "string", enum: ["activated", "resumed"] },
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    welcome: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        subscribeText: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const accountSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    name: { type: "string" },
    appId: { type: "string" },
    appSecret: { type: "string" },
    token: { type: "string" },
    encodingAESKey: { type: "string" },
    webhookPath: { type: "string" },
    requireHttps: { type: "boolean" },
    dm: dmSchema,
    routing: routingSchema,
    outbound: outboundSchema,
    voiceTranscribe: voiceTranscribeSchema,
    outboundRetryTimes: { type: "number" },
    outboundRetryCount: { type: "number" },
    outboundRetries: { type: "number" },
    outboundRetryDelayMs: { type: "number" },
    outboundRetryDelay: { type: "number" },
  },
  additionalProperties: false,
};

export const WempConfigSchema = {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    name: { type: "string" },
    appId: { type: "string" },
    appSecret: { type: "string" },
    token: { type: "string" },
    encodingAESKey: { type: "string" },
    webhookPath: { type: "string" },
    requireHttps: { type: "boolean" },
    dm: dmSchema,
    routing: routingSchema,
    outbound: outboundSchema,
    voiceTranscribe: voiceTranscribeSchema,
    outboundRetryTimes: { type: "number" },
    outboundRetryCount: { type: "number" },
    outboundRetries: { type: "number" },
    outboundRetryDelayMs: { type: "number" },
    outboundRetryDelay: { type: "number" },
    defaultAccount: { type: "string" },
    accounts: { type: "object", additionalProperties: accountSchema },
    features: featuresSchema,
  },
  additionalProperties: false,
};

// WempConfigSchema is a plain JSON Schema object; use it directly instead of
// buildChannelConfigSchema (which expects a Zod schema and falls back to
// { additionalProperties: true } for plain objects, breaking validation).
export const wempConfigSchema = { schema: WempConfigSchema };
