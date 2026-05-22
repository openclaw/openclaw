import { n as BaseTokenResolution } from "./types.core-remGx4m5.js";
//#region extensions/discord/src/token.d.ts
type DiscordTokenSource = "env" | "config" | "none";
type DiscordCredentialStatus = "available" | "configured_unavailable" | "missing";
type DiscordTokenResolution = BaseTokenResolution & {
  source: DiscordTokenSource;
  tokenStatus: DiscordCredentialStatus;
};
//#endregion
export { DiscordTokenResolution as n, DiscordCredentialStatus as t };