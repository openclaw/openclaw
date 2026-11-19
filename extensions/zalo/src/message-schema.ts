import { normalizeNullableString as nonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";

const nonEmptyWebhookStringSchema = z
  .string()
  .transform((value) => nonEmptyString(value))
  .pipe(z.string());
const optionalWebhookStringSchema = z.string().optional().catch(undefined);
export const webhookEnvelopeSchema = z
  .looseObject({
    ok: z.unknown().optional(),
    result: z.looseObject({}).optional().catch(undefined),
  })
  .transform((envelope) => (envelope.ok === true && envelope.result ? envelope.result : envelope));
export const webhookAdmissionSchema = z.looseObject({
  message: z.looseObject({
    message_id: nonEmptyWebhookStringSchema,
    chat: z.looseObject({ id: nonEmptyWebhookStringSchema }),
  }),
});
const webhookSenderSchema = z.object({
  id: nonEmptyWebhookStringSchema,
  name: optionalWebhookStringSchema,
  display_name: optionalWebhookStringSchema,
  avatar: optionalWebhookStringSchema,
  is_bot: z.boolean().optional().catch(undefined),
});
const webhookChatSchema = z.object({
  id: nonEmptyWebhookStringSchema,
  chat_type: z.enum(["PRIVATE", "GROUP"]),
});
export const webhookMessageSchema = z.object({
  message_id: nonEmptyWebhookStringSchema,
  from: webhookSenderSchema,
  chat: webhookChatSchema,
  date: z.number().finite(),
  text: optionalWebhookStringSchema,
  photo_url: optionalWebhookStringSchema,
  caption: optionalWebhookStringSchema,
  sticker: optionalWebhookStringSchema,
  message_type: optionalWebhookStringSchema,
});
export const webhookUpdateSchema = z
  .object({
    event_name: z.enum([
      "message.text.received",
      "message.image.received",
      "message.sticker.received",
      "message.unsupported.received",
    ]),
    message: webhookMessageSchema,
  })
  .superRefine((update, context) => {
    if (update.event_name === "message.text.received" && update.message.text === undefined) {
      context.addIssue({
        code: "custom",
        path: ["message", "text"],
        message: "text event requires message.text",
      });
    }
  });
