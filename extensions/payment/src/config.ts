import { z } from "zod";

// ---------------------------------------------------------------------------
// Provider sub-schemas
// ---------------------------------------------------------------------------

const stripeLinkProviderSchema = z
  .object({
    command: z.string().default("link-cli"),
    clientName: z.string().default("OpenClaw"),
    testMode: z.boolean().default(false),
    maxAmountCents: z
      .number()
      .int("maxAmountCents must be an integer")
      .positive("maxAmountCents must be greater than 0")
      .max(50000, "maxAmountCents must not exceed Stripe Link's hard cap of 50000")
      .default(50000),
  })
  .strict();

const mockProviderSchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// Providers sub-schema
//
// In zod v4+, .default(value) returns the default as-is without re-parsing it
// through the inner schema, so inner .default() calls would not fire when a
// nested key is omitted. zod 4.4 also tightened optionality semantics in
// z.preprocess, so we pre-fill missing keys at the outer providers level
// before the inner schemas run — that way each inner schema sees an object
// (possibly {}) and fires its own defaults.
// ---------------------------------------------------------------------------

const providersBaseSchema = z.preprocess(
  (val) => {
    const obj = val === undefined || val === null ? {} : (val as Record<string, unknown>);
    return {
      "stripe-link": obj["stripe-link"] ?? {},
      mock: obj.mock ?? {},
    };
  },
  z
    .object({
      "stripe-link": stripeLinkProviderSchema,
      mock: mockProviderSchema,
    })
    .strict(),
);

// ---------------------------------------------------------------------------
// Root config schema
// ---------------------------------------------------------------------------

const paymentConfigSchema = z.preprocess(
  (val) => {
    if (val === undefined || val === null) return val; // let zod surface the missing-input error
    if (typeof val !== "object") return val; // let zod surface the wrong-type error
    const obj = val as Record<string, unknown>;
    // Pre-fill `providers: {}` if missing so the providers preprocess fires its inner defaults.
    if (obj.providers === undefined) {
      return { ...obj, providers: {} };
    }
    return obj;
  },
  z
    .object({
      enabled: z.boolean().default(false),
      provider: z.enum(["stripe-link", "mock"], {
        error: "provider must be one of: stripe-link, mock",
      }),
      defaultCurrency: z.string().default("usd"),
      store: z.string().default("~/.openclaw/payments"),
      providers: providersBaseSchema,
    })
    .strict(),
);

// ---------------------------------------------------------------------------
// Exported types and functions
// ---------------------------------------------------------------------------

export type PaymentConfig = z.infer<typeof paymentConfigSchema>;

export { paymentConfigSchema };

/**
 * Parse and validate raw config input. Throws ZodError on invalid input.
 * The caller is responsible for formatting the error.
 */
export function parsePaymentConfig(raw: unknown): PaymentConfig {
  return paymentConfigSchema.parse(raw);
}

/**
 * Returns a sensible default PaymentConfig (disabled, mock provider).
 */
export function defaultPaymentConfig(): PaymentConfig {
  return {
    enabled: false,
    provider: "mock",
    defaultCurrency: "usd",
    store: "~/.openclaw/payments",
    providers: {
      "stripe-link": {
        command: "link-cli",
        clientName: "OpenClaw",
        testMode: false,
        maxAmountCents: 50000,
      },
      mock: {},
    },
  };
}
