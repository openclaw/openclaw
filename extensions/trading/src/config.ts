import { z } from "zod";

// =============================================================================
// Trading Configuration Schema
// =============================================================================

export const TradingConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.enum(["alpaca", "mock"]).default("mock"),
    apiKey: z.string().min(1).optional(),
    apiSecret: z.string().min(1).optional(),
    paperTrading: z.boolean().default(true),
    baseUrl: z.string().url().optional(),
  })
  .strict();

export type TradingConfig = z.infer<typeof TradingConfigSchema>;

// =============================================================================
// Config Resolution (env fallback)
// =============================================================================

export function resolveTradingConfig(config: TradingConfig): TradingConfig {
  return {
    ...config,
    apiKey: config.apiKey || process.env.ALPACA_API_KEY || undefined,
    apiSecret: config.apiSecret || process.env.ALPACA_API_SECRET || undefined,
  };
}

// =============================================================================
// Validation
// =============================================================================

export function validateProviderConfig(config: TradingConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.enabled) {
    return { valid: false, errors: ["Trading plugin is disabled"] };
  }

  if (config.provider === "alpaca") {
    if (!config.apiKey) {
      errors.push("Alpaca API key is required. Set apiKey in config or ALPACA_API_KEY env var.");
    }
    if (!config.apiSecret) {
      errors.push(
        "Alpaca API secret is required. Set apiSecret in config or ALPACA_API_SECRET env var.",
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
