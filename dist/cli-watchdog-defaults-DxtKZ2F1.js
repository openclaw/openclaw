//#region src/agents/cli-watchdog-defaults.ts
const CLI_WATCHDOG_MIN_TIMEOUT_MS = 1e3;
const CLI_FRESH_WATCHDOG_DEFAULTS = {
	noOutputTimeoutRatio: .8,
	minMs: 18e4,
	maxMs: 6e5
};
const CLI_RESUME_WATCHDOG_DEFAULTS = {
	noOutputTimeoutRatio: .3,
	minMs: 6e4,
	maxMs: 18e4
};
//#endregion
export { CLI_RESUME_WATCHDOG_DEFAULTS as n, CLI_WATCHDOG_MIN_TIMEOUT_MS as r, CLI_FRESH_WATCHDOG_DEFAULTS as t };
