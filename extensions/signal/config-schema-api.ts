import {
  buildChannelReactionShape,
  buildChannelAccountSchemaParts,
  buildGroupEntrySchema,
  ChannelDeliveryStreamingConfigSchema,
  ChannelSendReadReceiptsSchema,
  ExecutableTokenSchema,
  ReplyToModeSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";
import { assertSignalSocketTransport } from "./src/transport-url.js";

const SIGNAL_TRANSPORT_URL_PATTERN = /^[Hh][Tt][Tt][Pp][Ss]?:\/\/(?![^/?#]*@)/;
const SignalTransportUrlSchema = z
  .string()
  .url()
  // Keep this as a regex so the HTTP-only and credential-free contract survives JSON Schema
  // generation. Runtime URL parsing remains the final canonicalization boundary.
  .regex(
    SIGNAL_TRANSPORT_URL_PATTERN,
    "Expected http:// or https:// URL without embedded credentials",
  );

const SignalTransportSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("managed-native"),
      configPath: z.string().optional(),
      socketPath: z
        .string()
        .regex(/^\/(?!\/)[^\0]*[^/\0]$/, "Expected an absolute POSIX socket file path")
        .optional(),
      url: SignalTransportUrlSchema.optional(),
      httpHost: z.string().optional(),
      httpPort: z.number().int().min(1).max(65_535).optional(),
      cliPath: ExecutableTokenSchema.optional(),
      startupTimeoutMs: z.number().int().min(1000).max(120000).optional(),
      receiveMode: z.union([z.literal("on-start"), z.literal("manual")]).optional(),
      ignoreStories: z.boolean().optional(),
    })
    .strict()
    .superRefine((transport, ctx) => {
      try {
        assertSignalSocketTransport(transport);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          path: ["socketPath"],
          message: String(error instanceof Error ? error.message : error),
        });
      }
    }),
  z
    .object({
      kind: z.literal("external-native"),
      url: SignalTransportUrlSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("container"),
      url: SignalTransportUrlSchema,
    })
    .strict(),
]);

const DirectGroupReplyToModeByChatTypeSchema = z
  .object({
    direct: ReplyToModeSchema.optional(),
    group: ReplyToModeSchema.optional(),
  })
  .strict();

const SignalGroupEntrySchema = buildGroupEntrySchema(
  {
    ingest: z.boolean().optional(),
  },
  { omit: ["skills", "enabled", "allowFrom", "systemPrompt"] },
);

const SignalGroupsSchema = z.record(z.string(), SignalGroupEntrySchema.optional()).optional();

const { accountShape, rootPolicyShape: signalRootPolicyShape } = buildChannelAccountSchemaParts({
  omit: ["mentionPatterns"],
  streaming: ChannelDeliveryStreamingConfigSchema.optional(),
  mediaMaxMb: z.number().int().positive().optional(),
});

export const SignalAccountSchemaBase = z
  .object({
    ...accountShape,
    account: z.string().optional(),
    accountUuid: z.string().optional(),
    transport: SignalTransportSchema.optional(),
    ignoreAttachments: z.boolean().optional(),
    sendReadReceipts: ChannelSendReadReceiptsSchema,
    aliases: z.record(z.string(), z.string()).optional(),
    groups: SignalGroupsSchema,
    replyToModeByChatType: DirectGroupReplyToModeByChatTypeSchema.optional(),
    ...buildChannelReactionShape({
      notificationModes: ["off", "own", "all", "allowlist"],
      reactionAllowlist: true,
      reactionLevels: ["off", "ack", "minimal", "extensive"],
    }),
    actions: z
      .object({
        reactions: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export { signalRootPolicyShape };
