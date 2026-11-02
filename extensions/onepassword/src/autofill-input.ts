import { z } from "zod";
import { AutofillError } from "./autofill-relay.js";

const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}<>]*$/u);
const website = z
  .string()
  .trim()
  .max(2083)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  });
export const accessRequestInputSchema = z
  .object({
    version: z.literal(2),
    goal: plainText(140),
    entries: z
      .array(
        z
          .object({
            type: z.literal("login"),
            parameters: z.object({ website }).strict(),
            reason: plainText(100),
            keywords: z.array(plainText(50)).max(5).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();
const connectionKeySchema = z
  .object({
    ver: z.literal(1),
    typ: z.literal("oauth_integration_key"),
    key: z.string().regex(/^[0-9a-fA-F]{64}$/),
    path: z
      .string()
      .regex(
        /^\/\/api\.1password\.com\/oauth-clients\/[A-Za-z0-9_-]+\/accounts\/[A-Za-z0-9_-]+\/users\/[A-Za-z0-9_-]+$/,
      ),
  })
  .strict();

/** Validate the key once at pickup and bind storage to its full client/account/user path. */
export function decodeConnectionPath(integrationKey: string): { path: string; userId: string } {
  try {
    if (!/^ops_[A-Za-z0-9_-]+$/.test(integrationKey)) {
      throw new AutofillError("invalidIntegrationKey");
    }
    const decoded = connectionKeySchema.parse(
      JSON.parse(Buffer.from(integrationKey.slice(4), "base64url").toString("utf8")),
    );
    return { path: decoded.path, userId: decoded.path.slice(decoded.path.lastIndexOf("/") + 1) };
  } catch {
    throw new AutofillError("invalidIntegrationKey");
  }
}

/** Require exactly the explicit opt-in; the existing service-account config is independent. */
export function isAgenticAutofillEnabled(config: unknown): boolean {
  return z.object({ agenticAutofill: z.object({ enabled: z.literal(true) }) }).safeParse(config)
    .success;
}
