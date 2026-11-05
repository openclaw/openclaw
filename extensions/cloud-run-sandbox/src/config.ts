import path from "node:path";
import { buildPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { z } from "zod";

const schema = z.strictObject({
  rootfs: z
    .string()
    .refine(
      (value) => path.posix.isAbsolute(value) && path.posix.normalize(value) !== "/",
      "rootfs must be an absolute, dedicated guest root (never /)",
    ),
  allowEgress: z.boolean().default(false),
  guestLifetimeSeconds: z.number().int().min(30).max(3600).default(600),
});
export const configSchema = buildPluginConfigSchema(schema);
export type CloudRunConfig = z.infer<typeof schema>;
export function resolveConfig(value: unknown): CloudRunConfig {
  return schema.parse(value);
}
