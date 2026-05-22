import { n as TopLevelComponents, r as Embed, x as APIEmbed } from "./payload-U2icqU80.js";
//#region extensions/discord/src/send.message-request.d.ts
type DiscordSendComponentFactory = (text: string) => TopLevelComponents[];
type DiscordSendComponents = TopLevelComponents[] | DiscordSendComponentFactory;
type DiscordSendEmbeds = Array<APIEmbed | Embed>;
//#endregion
export { DiscordSendEmbeds as n, DiscordSendComponents as t };