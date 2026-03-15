import { z } from "zod";

export const AiriAvatarConfigSchema = z
  .object({
    type: z.enum(["vrm", "live2d"]).default("vrm"),
    modelUrl: z.string().url().optional(),
  })
  .strict()
  .default({ type: "vrm" });
export type AiriAvatarConfig = z.infer<typeof AiriAvatarConfigSchema>;

export const AiriTtsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    streamAudio: z.boolean().default(true),
  })
  .strict()
  .default({ enabled: true, streamAudio: true });
export type AiriTtsConfig = z.infer<typeof AiriTtsConfigSchema>;

export const AiriReconnectConfigSchema = z
  .object({
    maxRetries: z.number().int().nonnegative().default(10),
    intervalMs: z.number().int().positive().default(5000),
  })
  .strict()
  .default({ maxRetries: 10, intervalMs: 5000 });
export type AiriReconnectConfig = z.infer<typeof AiriReconnectConfigSchema>;

export const AiriConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    host: z.string().default("127.0.0.1"),
    port: z.number().int().positive().default(18900),
    token: z.string().optional(),
    avatar: AiriAvatarConfigSchema,
    tts: AiriTtsConfigSchema,
    reconnect: AiriReconnectConfigSchema,
  })
  .strict();

export type AiriConfig = z.infer<typeof AiriConfigSchema>;

export function resolveAiriConfig(config: AiriConfig): AiriConfig {
  const resolved = structuredClone(config);
  resolved.host = resolved.host || process.env.AIRI_BRIDGE_HOST || "127.0.0.1";
  resolved.port = resolved.port || Number(process.env.AIRI_BRIDGE_PORT) || 18900;
  resolved.token = resolved.token || process.env.AIRI_BRIDGE_TOKEN;
  return resolved;
}

export function validateAiriConfig(config: AiriConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!config.enabled) {
    return { valid: true, errors: [] };
  }
  if (!config.host) {
    errors.push("plugins.entries.airi.config.host is required");
  }
  if (!config.port || config.port <= 0 || config.port > 65535) {
    errors.push("plugins.entries.airi.config.port must be a valid port (1-65535)");
  }
  return { valid: errors.length === 0, errors };
}
