//#region src/agents/cli-watchdog-defaults.d.ts
declare const CLI_FRESH_WATCHDOG_DEFAULTS: {
  readonly noOutputTimeoutRatio: 0.8;
  readonly minMs: 180000;
  readonly maxMs: 600000;
};
declare const CLI_RESUME_WATCHDOG_DEFAULTS: {
  readonly noOutputTimeoutRatio: 0.3;
  readonly minMs: 60000;
  readonly maxMs: 180000;
};
//#endregion
export { CLI_RESUME_WATCHDOG_DEFAULTS as n, CLI_FRESH_WATCHDOG_DEFAULTS as t };