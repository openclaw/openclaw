import { z } from "zod";
import { VisitorAccessError } from "./errors.js";
import { VISITOR_NOTE_MAX_CHARS, visitorNoteSchema } from "./grant-record.js";

const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((email) => email.toLowerCase());
const identityFields = {
  github: z
    .string()
    .trim()
    .min(1)
    .transform((login) => login.toLowerCase())
    .optional(),
  email: emailSchema.optional(),
};
export const revokeSchema = z.strictObject({
  ...identityFields,
  profileId: z.string().trim().min(1).max(128).optional(),
  grantId: z.uuid().optional(),
});
export const inviteSchema = z
  .strictObject({
    ...identityFields,
    days: z.number().int().min(1).max(3650).optional(),
    forever: z.boolean().optional(),
    note: visitorNoteSchema.optional(),
  })
  .refine((input) => (input.email !== undefined) !== (input.github !== undefined));
export const grantIdSchema = z.uuid();
export function parseVisitorInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new VisitorAccessError(
      `Invalid visitor input. Use a valid email or GitHub login, days from 1 to 3650, or forever: true. A note must be a string of at most ${VISITOR_NOTE_MAX_CHARS} characters.`,
    );
  }
  return result.data;
}
