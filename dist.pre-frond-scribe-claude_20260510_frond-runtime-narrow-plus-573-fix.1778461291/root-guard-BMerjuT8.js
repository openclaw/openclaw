import process from "node:process";
//#region src/cli/root-guard.ts
/**
* Block CLI execution when running as root (uid 0 or euid 0) unless explicitly opted in.
*
* Running as root causes:
* - Separate state dir (/root/.openclaw/ vs /home/<user>/.openclaw/)
* - Conflicting systemd user services (port 18789 race)
* - Root-owned files in the service user's state dir (EACCES)
*/
function assertNotRoot(env = process.env) {
	if (typeof process.getuid !== "function") return;
	const uid = process.getuid();
	const euid = typeof process.geteuid === "function" ? process.geteuid() : uid;
	if (uid !== 0 && euid !== 0) return;
	if (env.OPENCLAW_ALLOW_ROOT === "1" || env.OPENCLAW_CLI_CONTAINER_BYPASS === "1" && env.OPENCLAW_CONTAINER_HINT) return;
	process.stderr.write("[openclaw] Refusing to run as root.\n\nWhy this is blocked:\n  - A separate state directory under /root/.openclaw/ instead of the service user's\n  - Conflicting systemd user services that race on port 18789\n  - Root-owned files in the service user's state dir (EACCES errors)\n\nWhat to do:\n  - Re-run as the service user: sudo -u <service-user> -H openclaw ...\n  - Or switch shells first: su - <service-user>\n\nIntentional container/CI run only:\n  OPENCLAW_ALLOW_ROOT=1 openclaw ...\n");
	process.exit(1);
}
//#endregion
export { assertNotRoot as t };
