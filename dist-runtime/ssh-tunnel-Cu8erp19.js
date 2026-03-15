import { o as isErrno } from "./errors-CHvVoeNX.js";
import { r as ensurePortAvailable } from "./ports-DeHp-MTZ.js";
import { spawn } from "node:child_process";
import net from "node:net";
//#region src/infra/ssh-tunnel.ts
function parseSshTarget(raw) {
	const trimmed = raw.trim().replace(/^ssh\s+/, "");
	if (!trimmed) {return null;}
	const [userPart, hostPart] = trimmed.includes("@") ? (() => {
		const idx = trimmed.indexOf("@");
		const user = trimmed.slice(0, idx).trim();
		const host = trimmed.slice(idx + 1).trim();
		return [user || void 0, host];
	})() : [void 0, trimmed];
	const colonIdx = hostPart.lastIndexOf(":");
	if (colonIdx > 0 && colonIdx < hostPart.length - 1) {
		const host = hostPart.slice(0, colonIdx).trim();
		const portRaw = hostPart.slice(colonIdx + 1).trim();
		const port = Number.parseInt(portRaw, 10);
		if (!host || !Number.isFinite(port) || port <= 0) {return null;}
		if (host.startsWith("-")) {return null;}
		return {
			user: userPart,
			host,
			port
		};
	}
	if (!hostPart) {return null;}
	if (hostPart.startsWith("-")) {return null;}
	return {
		user: userPart,
		host: hostPart,
		port: 22
	};
}
async function pickEphemeralPort() {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			server.close(() => {
				if (!addr || typeof addr === "string") {
					reject(/* @__PURE__ */ new Error("failed to allocate a local port"));
					return;
				}
				resolve(addr.port);
			});
		});
	});
}
async function canConnectLocal(port) {
	return await new Promise((resolve) => {
		const socket = net.connect({
			host: "127.0.0.1",
			port
		});
		const done = (ok) => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(ok);
		};
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
		socket.setTimeout(250, () => done(false));
	});
}
async function waitForLocalListener(port, timeoutMs) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await canConnectLocal(port)) {return;}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`ssh tunnel did not start listening on localhost:${port}`);
}
async function startSshPortForward(opts) {
	const parsed = parseSshTarget(opts.target);
	if (!parsed) {throw new Error(`invalid SSH target: ${opts.target}`);}
	let localPort = opts.localPortPreferred;
	try {
		await ensurePortAvailable(localPort);
	} catch (err) {
		if (isErrno(err) && err.code === "EADDRINUSE") {localPort = await pickEphemeralPort();}
		else {throw err;}
	}
	const userHost = parsed.user ? `${parsed.user}@${parsed.host}` : parsed.host;
	const args = [
		"-N",
		"-L",
		`${localPort}:127.0.0.1:${opts.remotePort}`,
		"-p",
		String(parsed.port),
		"-o",
		"ExitOnForwardFailure=yes",
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=yes",
		"-o",
		"UpdateHostKeys=yes",
		"-o",
		"ConnectTimeout=5",
		"-o",
		"ServerAliveInterval=15",
		"-o",
		"ServerAliveCountMax=3"
	];
	if (opts.identity?.trim()) {args.push("-i", opts.identity.trim());}
	args.push("--", userHost);
	const stderr = [];
	const child = spawn("/usr/bin/ssh", args, { stdio: [
		"ignore",
		"ignore",
		"pipe"
	] });
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk) => {
		const lines = String(chunk).split("\n").map((l) => l.trim()).filter(Boolean);
		stderr.push(...lines);
	});
	const stop = async () => {
		if (child.killed) {return;}
		child.kill("SIGTERM");
		await new Promise((resolve) => {
			const t = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} finally {
					resolve();
				}
			}, 1500);
			child.once("exit", () => {
				clearTimeout(t);
				resolve();
			});
		});
	};
	try {
		await Promise.race([waitForLocalListener(localPort, Math.max(250, opts.timeoutMs)), new Promise((_, reject) => {
			child.once("exit", (code, signal) => {
				reject(/* @__PURE__ */ new Error(`ssh exited (${code ?? "null"}${signal ? `/${signal}` : ""})`));
			});
		})]);
	} catch (err) {
		await stop();
		const suffix = stderr.length > 0 ? `\n${stderr.join("\n")}` : "";
		throw new Error(`${err instanceof Error ? err.message : String(err)}${suffix}`, { cause: err });
	}
	return {
		parsedTarget: parsed,
		localPort,
		remotePort: opts.remotePort,
		pid: typeof child.pid === "number" ? child.pid : null,
		stderr,
		stop
	};
}
//#endregion
export { startSshPortForward as n, parseSshTarget as t };
