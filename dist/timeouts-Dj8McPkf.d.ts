//#region extensions/discord/src/monitor/timeouts.d.ts
declare const DISCORD_DEFAULT_LISTENER_TIMEOUT_MS = 120000;
declare const DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS: number;
declare const DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS = 60000;
declare const DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS = 120000;
declare function mergeAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined;
//#endregion
export { mergeAbortSignals as a, DISCORD_DEFAULT_LISTENER_TIMEOUT_MS as i, DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS as n, DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS as r, DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS as t };