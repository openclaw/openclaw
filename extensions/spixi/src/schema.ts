import { z } from "zod";
import { DmPolicySchema, GroupPolicySchema } from "../../../src/config/zod-schema.core.js";

export const SpixiAccountSchemaBase = z
  .object({
    enabled: z.boolean().optional().describe("Enable or disable this Spixi account."),
    name: z.string().optional().describe("Friendly name for this account."),
    quixiApiUrl: z
      .string()
      .optional()
      .default("http://localhost:8001")
      .describe(
        "URL of the QuIXI API. WARNING: Requires a running QuIXI node on the server. Repo: https://github.com/ixian-platform/QuIXI",
      ),
    mqttHost: z
      .string()
      .optional()
      .default("127.0.0.1")
      .describe(
        "Hostname of the MQTT broker. WARNING: Requires an MQTT broker (e.g. Aedes or Mosquitto) for real-time messages.",
      ),
    mqttPort: z
      .number()
      .int()
      .positive()
      .optional()
      .default(1883)
      .describe("Port of the MQTT broker."),
    myWalletAddress: z
      .string()
      .optional()
      .describe("Your Ixian wallet address. Used to filter out self-messages."),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
  })
  .strict();

export const SpixiAccountSchema = SpixiAccountSchemaBase;

export const SpixiConfigSchema = SpixiAccountSchemaBase.extend({
  accounts: z.record(z.string(), SpixiAccountSchema.optional()).optional(),
});
