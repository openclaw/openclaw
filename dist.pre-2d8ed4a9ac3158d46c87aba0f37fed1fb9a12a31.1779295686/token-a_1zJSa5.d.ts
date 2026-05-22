import { i as OpenClawConfig } from "./types.openclaw-DPnlcagS.js";
import { n as BaseTokenResolution } from "./types.core-remGx4m5.js";
//#region extensions/telegram/src/token.d.ts
type TelegramTokenSource = "env" | "tokenFile" | "config" | "none";
type TelegramTokenResolution = BaseTokenResolution & {
  source: TelegramTokenSource;
};
type ResolveTelegramTokenOpts = {
  envToken?: string | null;
  accountId?: string | null;
  logMissingFile?: (message: string) => void;
};
declare function resolveTelegramToken(cfg?: OpenClawConfig, opts?: ResolveTelegramTokenOpts): TelegramTokenResolution;
//#endregion
export { resolveTelegramToken as n, TelegramTokenResolution as t };