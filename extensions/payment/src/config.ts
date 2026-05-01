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
      .default(50000),
  })
  .strict();

const mockProviderSchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// Providers sub-schema
//
// z.preprocess normalises undefined/missing values to {} before the inner
// schema runs, so that inner .default() calls fire correctly.
// In zod v4, .default(value) returns the default as-is without re-parsing it
// through the schema, so we use preprocess to bridge the gap.
// ---------------------------------------------------------------------------

const providersBaseSchema = z
  .object({
    "stripe-link": z.preprocess((val) => (val === undefined ? {} : val), stripeLinkProviderSchema),
    mock: z.preprocess((val) => (val === undefined ? {} : val), mockProviderSchema),
  })
  .strict();

// ---------------------------------------------------------------------------
// Root config schema
// ---------------------------------------------------------------------------

const paymentConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(["stripe-link", "mock"], {
      error: "provider must be one of: stripe-link, mock",
    }),
    defaultCurrency: z.string().default("usd"),
    store: z.string().default("~/.openclaw/payments"),
    providers: z.preprocess((val) => (val === undefined ? {} : val), providersBaseSchema),
  })
  .strict();

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
