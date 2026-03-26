/** On-demand service start/stop for fleet services with lifecycle configs. */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FleetConfig, FleetNodeConfig, FleetServiceConfig } from "./types.js";
import { acquireLock, releaseLock } from "../shared/fleet-redis.js";

const execFileAsync = promisify(execFile);

async function sshExec(node: FleetNodeConfig, command: string, timeoutMs = 30000): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	try {
		const { stdout, stderr } = await execFileAsync("ssh", [
			"-o", "StrictHostKeyChecking=no",
			"-o", "ConnectTimeout=10",
			"-o", "BatchMode=yes",
			`${node.sshUser}@${node.tailscaleIp}`,
			command,
		], { timeout: timeoutMs });
		return { stdout, stderr, exitCode: 0 };
	} catch (err: unknown) {
		const e = err as { stdout?: string; stderr?: string; code?: number };
		return { stdout: e.stdout || "", stderr: e.stderr || String(err), exitCode: e.code || 1 };
	}
}

export async function startService(
	config: FleetConfig,
	nodeName: string,
	serviceName: string,
): Promise<{ success: boolean; output: string }> {
	const node = config.nodes[nodeName];
	if (!node || node.active === false) return { success: false, output: `Node ${nodeName} not available` };

	const service = node.services?.[serviceName];
	if (!service?.lifecycle) return { success: false, output: `Service ${serviceName} has no lifecycle config` };

	// Acquire resource lock
	const lockKey = `${nodeName}:${serviceName}`;
	const locked = await acquireLock(lockKey, `service-lifecycle:${Date.now()}`, 300);
	if (!locked) return { success: false, output: `Lock contention on ${lockKey}` };

	try {
		const result = await sshExec(node, service.lifecycle.startCmd, service.lifecycle.startTimeoutMs || 30000);
		return { success: result.exitCode === 0, output: result.stdout || result.stderr };
	} finally {
		await releaseLock(lockKey, `service-lifecycle:${Date.now()}`);
	}
}

export async function stopService(
	config: FleetConfig,
	nodeName: string,
	serviceName: string,
): Promise<{ success: boolean; output: string }> {
	const node = config.nodes[nodeName];
	if (!node || node.active === false) return { success: false, output: `Node ${nodeName} not available` };

	const service = node.services?.[serviceName];
	if (!service?.lifecycle) return { success: false, output: `Service ${serviceName} has no lifecycle config` };

	const result = await sshExec(node, service.lifecycle.stopCmd);
	return { success: result.exitCode === 0, output: result.stdout || result.stderr };
}
