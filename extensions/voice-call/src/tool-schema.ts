import { Type } from "typebox";

const VoiceCallBriefToolSchema = Type.Object(
  {
    task: Type.Optional(Type.String({ maxLength: 2000 })),
    context: Type.Optional(Type.String({ maxLength: 4000 })),
    language: Type.Optional(Type.String({ maxLength: 100 })),
    identity: Type.Optional(
      Type.Union([
        Type.String({ maxLength: 500 }),
        Type.Object(
          {
            introduction: Type.String({ maxLength: 500 }),
            disclose: Type.Optional(
              Type.Union([Type.Literal("volunteer"), Type.Literal("when-asked")]),
            ),
          },
          { additionalProperties: false },
        ),
      ]),
    ),
    disclosures: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })),
    approvals: Type.Optional(Type.String({ maxLength: 2000 })),
    voicemailMessage: Type.Optional(Type.String({ maxLength: 1000 })),
    successCriteria: Type.Optional(Type.String({ maxLength: 1000 })),
    maxDurationSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const VoiceCallToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("initiate_call"),
    brief: Type.Optional(VoiceCallBriefToolSchema),
    to: Type.Optional(Type.String({ description: "Call target" })),
    message: Type.String({ description: "Intro message" }),
    mode: Type.Optional(Type.Union([Type.Literal("notify"), Type.Literal("conversation")])),
    sessionKey: Type.Optional(Type.String({ description: "OpenClaw session key for the call" })),
    dtmfSequence: Type.Optional(Type.String({ description: "DTMF digits to play before connect" })),
  }),
  Type.Object({
    action: Type.Literal("steer_call"),
    callId: Type.String({ description: "Exact active call ID" }),
    message: Type.String({ maxLength: 500, description: "Owner instruction for the live call" }),
    mode: Type.Optional(Type.Union([Type.Literal("say"), Type.Literal("guidance")])),
  }),
  Type.Object({
    action: Type.Literal("continue_call"),
    callId: Type.String({ description: "Call ID" }),
    message: Type.String({ description: "Follow-up message" }),
  }),
  Type.Object({
    action: Type.Literal("speak_to_user"),
    callId: Type.String({ description: "Call ID" }),
    message: Type.String({ description: "Message to speak" }),
  }),
  Type.Object({
    action: Type.Literal("send_dtmf"),
    callId: Type.String({ description: "Call ID" }),
    digits: Type.String({ description: "DTMF digits to send" }),
  }),
  Type.Object({
    action: Type.Literal("end_call"),
    callId: Type.String({ description: "Call ID" }),
  }),
  Type.Object({
    action: Type.Literal("get_status"),
    callId: Type.String({ description: "Call ID" }),
  }),
  Type.Object({
    mode: Type.Optional(Type.Union([Type.Literal("call"), Type.Literal("status")])),
    to: Type.Optional(Type.String({ description: "Call target" })),
    sid: Type.Optional(Type.String({ description: "Call SID" })),
    message: Type.Optional(Type.String({ description: "Optional intro message" })),
    sessionKey: Type.Optional(Type.String({ description: "OpenClaw session key for the call" })),
    dtmfSequence: Type.Optional(Type.String({ description: "DTMF digits to play before connect" })),
  }),
]);
