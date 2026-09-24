import { Type } from "typebox";
import { closedObject } from "./closed-object.js";

const ChannelIdentityPartSchema = Type.String({
  minLength: 1,
  maxLength: 512,
  pattern: "^\\S(?:.*\\S)?$",
});
export const UserChannelIdentitySchema = closedObject({
  channelId: ChannelIdentityPartSchema,
  accountId: ChannelIdentityPartSchema,
  senderId: ChannelIdentityPartSchema,
});
