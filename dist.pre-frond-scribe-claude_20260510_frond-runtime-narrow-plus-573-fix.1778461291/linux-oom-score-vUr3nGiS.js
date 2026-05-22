import fs from "node:fs";
//#region src/process/linux-oom-score.ts
/**
* On Linux, children spawned by a long-lived parent (e.g., the gateway) inherit
* the parent's `oom_score_adj`. Under cgroup memory pressure the kernel tends
* to pick the largest-RSS process as the OOM victim, which is usually the
* gateway rather than its transient workers. See issue #70404.
*
* Since Linux 2.6.20 any unprivileged process may voluntarily *raise* its own
* `oom_score_adj` without `CAP_SYS_RESOURCE`. We exploit that by wrapping the
* child argv in a tiny `/bin/sh` shim that raises the score in the post-fork
* child and then `exec`s the real command, so there is no extra long-lived
* shell process and no change to the final process identity.
*
* Opt out per-process by setting `OPENCLAW_CHILD_OOM_SCORE_ADJ=0` (also
* accepts `false`/`no`/`off`). Callers may also provide the key via
* `params.env` for per-child overrides.
*/
const CHILD_OOM_SCORE_ADJ_ENV_KEY = "OPENCLAW_CHILD_OOM_SCORE_ADJ";
const OOM_SCORE_WRAP_SHELL = "/bin/sh";
const OOM_SCORE_WRAP_SCRIPT = "echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec \"$0\" \"$@\"";
const SHELL_INIT_ENV_KEYS = [
	"BASH_ENV",
	"ENV",
	"CDPATH"
];
function isDisabled(value) {
	switch (value?.trim().toLowerCase()) {
		case "0":
		case "false":
		case "no":
		case "off": return true;
		default: return false;
	}
}
let cachedShellAvailable = null;
function defaultShellAvailable() {
	if (cachedShellAvailable !== null) return cachedShellAvailable;
	try {
		cachedShellAvailable = fs.statSync(OOM_SCORE_WRAP_SHELL).isFile();
	} catch {
		cachedShellAvailable = false;
	}
	return cachedShellAvailable;
}
function shouldWrapChildForOomScore(options) {
	if ((options?.platform ?? process.platform) !== "linux") return false;
	if (isDisabled((options?.env ?? process.env)[CHILD_OOM_SCORE_ADJ_ENV_KEY])) return false;
	return (options?.shellAvailable ?? defaultShellAvailable)();
}
function isWrapped(command, args) {
	return command === OOM_SCORE_WRAP_SHELL && args[0] === "-c" && args[1] === OOM_SCORE_WRAP_SCRIPT;
}
function canUseShellExecCommand(command) {
	return !command.startsWith("-");
}
function hardenShellEnv(baseEnv) {
	const next = { ...baseEnv ?? process.env };
	for (const key of SHELL_INIT_ENV_KEYS) delete next[key];
	return next;
}
function prepareOomScoreAdjustedSpawn(command, args = [], options) {
	const copy = [...args];
	if (!command || !canUseShellExecCommand(command) || !shouldWrapChildForOomScore(options)) return {
		command,
		args: copy,
		env: options?.env,
		wrapped: false
	};
	if (isWrapped(command, copy)) return {
		command,
		args: copy,
		env: hardenShellEnv(options?.env),
		wrapped: true
	};
	return {
		command: OOM_SCORE_WRAP_SHELL,
		args: [
			"-c",
			OOM_SCORE_WRAP_SCRIPT,
			command,
			...copy
		],
		env: hardenShellEnv(options?.env),
		wrapped: true
	};
}
//#endregion
export { prepareOomScoreAdjustedSpawn as t };
