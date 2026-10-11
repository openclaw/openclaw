import { Type } from "typebox";
import { SESSION_COMMUNICATION_MODES } from "../session-communication.js";
import { closedObject } from "./closed-object.js";

export type {
  SessionCommunicationMode,
  SessionCommunicationPolicy,
  EffectiveSessionCommunicationPolicy,
} from "../session-communication.js";

export const SessionCommunicationModeSchema = Type.Union([
  Type.Literal(SESSION_COMMUNICATION_MODES[0]),
  Type.Literal(SESSION_COMMUNICATION_MODES[1]),
  Type.Literal(SESSION_COMMUNICATION_MODES[2]),
]);
export const SessionCommunicationPolicySchema = closedObject({
  send: Type.Optional(SessionCommunicationModeSchema),
  receive: Type.Optional(SessionCommunicationModeSchema),
});
export const EffectiveSessionCommunicationPolicySchema = closedObject({
  send: SessionCommunicationModeSchema,
  receive: SessionCommunicationModeSchema,
});
export const SessionCommunicationPatchSchema = closedObject({
  send: Type.Optional(Type.Union([SessionCommunicationModeSchema, Type.Null()])),
  receive: Type.Optional(Type.Union([SessionCommunicationModeSchema, Type.Null()])),
});
