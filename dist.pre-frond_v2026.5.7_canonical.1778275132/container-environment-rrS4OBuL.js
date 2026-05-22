import fs from "node:fs";
//#region src/infra/container-environment.ts
/**
* Detect whether the current process is running inside a container
* (Docker, Podman, or Kubernetes).
*
* Uses two reliable heuristics:
* - Presence of common container sentinel files.
* - Container-related entries in /proc/1/cgroup.
*
* The result is cached after the first call so filesystem access happens at
* most once per process lifetime.
*/
let containerEnvironmentCache;
function isContainerEnvironment() {
	if (containerEnvironmentCache !== void 0) return containerEnvironmentCache;
	containerEnvironmentCache = detectContainerEnvironment();
	return containerEnvironmentCache;
}
function detectContainerEnvironment() {
	for (const sentinelPath of [
		"/.dockerenv",
		"/run/.containerenv",
		"/var/run/.containerenv"
	]) try {
		fs.accessSync(sentinelPath, fs.constants.F_OK);
		return true;
	} catch {}
	try {
		const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
		if (/\/docker\/|cri-containerd-[0-9a-f]|containerd\/[0-9a-f]{64}|\/kubepods[/.]|\blxc\b/.test(cgroup)) return true;
	} catch {}
	return false;
}
//#endregion
export { isContainerEnvironment as t };
