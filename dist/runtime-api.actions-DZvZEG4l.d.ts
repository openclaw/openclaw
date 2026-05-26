import { n as DiscordChannelEdit, r as DiscordChannelMove, t as DiscordChannelCreate } from "./send.types-BusQAPVK.js";
//#region extensions/discord/src/actions/runtime.moderation-shared.d.ts
type DiscordModerationAction = "timeout" | "kick" | "ban";
type DiscordModerationCommand = {
  action: DiscordModerationAction;
  guildId: string;
  userId: string;
  durationMinutes?: number;
  until?: string;
  reason?: string;
  deleteMessageDays?: number;
};
declare function isDiscordModerationAction(action: string): action is DiscordModerationAction;
declare function requiredGuildPermissionForModerationAction(action: DiscordModerationAction): bigint;
declare function readDiscordModerationCommand(action: string, params: Record<string, unknown>): DiscordModerationCommand;
//#endregion
//#region extensions/discord/src/actions/runtime.shared.d.ts
declare function readDiscordParentIdParam(params: Record<string, unknown>): string | null | undefined;
declare function readDiscordChannelCreateParams(params: Record<string, unknown>): DiscordChannelCreate;
declare function readDiscordChannelEditParams(params: Record<string, unknown>): DiscordChannelEdit;
declare function readDiscordChannelMoveParams(params: Record<string, unknown>): DiscordChannelMove;
//#endregion
export { DiscordModerationAction as a, readDiscordModerationCommand as c, readDiscordParentIdParam as i, requiredGuildPermissionForModerationAction as l, readDiscordChannelEditParams as n, DiscordModerationCommand as o, readDiscordChannelMoveParams as r, isDiscordModerationAction as s, readDiscordChannelCreateParams as t };