//#region src/infra/openclaw-exec-env.ts
const OPENCLAW_CLI_ENV_VAR = "OPENCLAW_CLI";
function markOpenClawExecEnv(env) {
	return {
		...env,
		[OPENCLAW_CLI_ENV_VAR]: "1"
	};
}
function ensureOpenClawExecMarkerOnProcess(env = process.env) {
	env[OPENCLAW_CLI_ENV_VAR] = "1";
	return env;
}
//#endregion
export { markOpenClawExecEnv as n, ensureOpenClawExecMarkerOnProcess as t };
