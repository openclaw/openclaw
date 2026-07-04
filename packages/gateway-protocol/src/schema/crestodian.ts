// Gateway Protocol schema module defines Crestodian chat payloads.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Crestodian chat lets clients (macOS app onboarding, future UIs) hold the
 * setup/repair conversation over the gateway. It is configless-safe: the
 * engine answers deterministically before any model is configured. Omitting
 * `message` returns the welcome/greeting for a fresh session without input.
 */
export const CrestodianChatParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    message: Type.Optional(Type.String()),
    /** "onboarding" seeds the first-run setup proposal in the greeting. */
    welcomeVariant: Type.Optional(Type.Union([Type.Literal("onboarding")])),
    /** Drop any in-flight approval/wizard state and start the session over. */
    reset: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** One Crestodian reply; `action` tells clients about conversation handoffs. */
export const CrestodianChatResultSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    reply: NonEmptyString,
    action: Type.Union([
      Type.Literal("none"),
      // The user asked to talk to their agent; clients should move to their
      // normal agent chat surface.
      Type.Literal("open-agent"),
      Type.Literal("exit"),
    ]),
  },
  { additionalProperties: false },
);
