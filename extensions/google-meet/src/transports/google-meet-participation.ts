import type {
  MeetingBrowserParticipationAdapter,
  MeetingParticipationRequest,
} from "openclaw/plugin-sdk/meeting-runtime";
import { z } from "zod";
import { meetPrepareChatScript, meetSendChatScript } from "./google-meet-chat-scripts.js";

const chatActionSchema = z.strictObject({
  type: z.literal("chat.send"),
  text: z
    .string()
    .max(4_000)
    .refine((value) => value.trim().length > 0),
  output: z.enum(["chat", "voice"]).optional(),
});

export function parseGoogleMeetChatAction(action: MeetingParticipationRequest["action"]) {
  return chatActionSchema.parse(action);
}

const actionResultSchema = z.union([
  z.object({
    status: z.literal("succeeded"),
    observed: z.object({ confirmation: z.literal("composer_cleared") }),
  }),
  z.object({
    status: z.enum(["failed", "uncertain", "unsupported", "rejected"]),
    message: z.string().optional(),
  }),
]);

function validateGoogleMeetParticipationAction(
  action: MeetingParticipationRequest["action"],
): string | undefined {
  return chatActionSchema.safeParse(action).success
    ? undefined
    : "chat.send requires nonblank text of at most 4000 UTF-16 units and an optional chat or voice output.";
}

export const GOOGLE_MEET_PARTICIPATION: MeetingBrowserParticipationAdapter = {
  capabilities: ["chat.send"],
  validateAction: validateGoogleMeetParticipationAction,
  buildPreparationScript: meetPrepareChatScript,
  parsePreparationResult(result) {
    const wire = z.object({ result: z.string() }).safeParse(result);
    if (wire.success) {
      try {
        if (
          z.object({ status: z.literal("prepared") }).safeParse(JSON.parse(wire.data.result))
            .success
        ) {
          return { status: "succeeded" };
        }
      } catch {
        // Preparation never sends; malformed readiness is a safe failure.
      }
    }
    return { status: "failed", message: "Meet chat did not become ready to compose." };
  },
  buildActionScript(params) {
    const action = parseGoogleMeetChatAction(params.action);
    if (action.output === "voice") {
      throw new Error("Voice replies must pass through the active meeting speech owner.");
    }
    return meetSendChatScript({
      meetingSessionId: params.meetingSessionId,
      meetingUrl: params.meetingUrl,
      requestId: params.requestId,
      text: action.text,
      source: params.source,
    });
  },
  parseActionResult(result) {
    const wire = z.object({ result: z.string() }).safeParse(result);
    if (!wire.success) {
      return { status: "uncertain", message: "Meet returned no chat action acknowledgment." };
    }
    try {
      const parsed = actionResultSchema.safeParse(JSON.parse(wire.data.result));
      return parsed.success
        ? parsed.data
        : { status: "uncertain", message: "Meet returned an invalid chat action acknowledgment." };
    } catch {
      return {
        status: "uncertain",
        message: "Meet returned an invalid chat action acknowledgment.",
      };
    }
  },
};
