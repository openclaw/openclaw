//#region extensions/discord/src/session-key-normalization.d.ts
type DiscordSessionKeyContext = {
  ChatType?: string;
  From?: string;
  SenderId?: string;
};
declare function normalizeExplicitDiscordSessionKey(sessionKey: string, ctx: DiscordSessionKeyContext): string;
//#endregion
export { normalizeExplicitDiscordSessionKey as t };