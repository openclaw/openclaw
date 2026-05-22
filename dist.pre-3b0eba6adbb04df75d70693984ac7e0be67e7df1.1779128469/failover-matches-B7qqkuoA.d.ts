//#region src/agents/live-model-errors.d.ts
declare function isModelNotFoundErrorMessage(raw: string): boolean;
//#endregion
//#region src/agents/pi-embedded-helpers/failover-matches.d.ts
declare function isTimeoutErrorMessage(raw: string): boolean;
declare function isBillingErrorMessage(raw: string): boolean;
declare function isAuthErrorMessage(raw: string): boolean;
declare function isOverloadedErrorMessage(raw: string): boolean;
declare function isServerErrorMessage(raw: string): boolean;
//#endregion
export { isTimeoutErrorMessage as a, isServerErrorMessage as i, isBillingErrorMessage as n, isModelNotFoundErrorMessage as o, isOverloadedErrorMessage as r, isAuthErrorMessage as t };