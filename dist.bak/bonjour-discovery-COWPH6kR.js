import { t as runCommandWithTimeout } from "./exec-BhaMholX.js";
import { t as isTailnetIPv4 } from "./tailnet-Ca1WnFBq.js";
import { n as resolveWideAreaDiscoveryDomain } from "./widearea-dns-Ah8QpopA.js";

//#region src/infra/bonjour-discovery.ts
const DEFAULT_TIMEOUT_MS = 2e3;
const GATEWAY_SERVICE_TYPE = "_openclaw-gw._tcp";
function decodeDnsSdEscapes(value) {
	let decoded = false;
	const bytes = [];
	let pending = "";
	const flush = () => {
		if (!pending) return;
		bytes.push(...Buffer.from(pending, "utf8"));
		pending = "";
	};
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i] ?? "";
		if (ch === "\\" && i + 3 < value.length) {
			const escaped = value.slice(i + 1, i + 4);
			if (/^[0-9]{3}$/.test(escaped)) {
				const byte = Number.parseInt(escaped, 10);
				if (!Number.isFinite(byte) || byte < 0 || byte > 255) {
					pending += ch;
					continue;
				}
				flush();
				bytes.push(byte);
				decoded = true;
				i += 3;
				continue;
			}
		}
		pending += ch;
	}
	if (!decoded) return value;
	flush();
	return Buffer.from(bytes).toString("utf8");
}
function parseDigShortLines(stdout) {
	return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}
function parseDigTxt(stdout) {
	const tokens = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const matches = Array.from(line.matchAll(/"([^"]*)"/g), (m) => m[1] ?? "");
		for (const m of matches) {
			const unescaped = m.replaceAll("\\\\", "\\").replaceAll("\\\"", "\"").replaceAll("\\n", "\n");
			tokens.push(unescaped);
		}
	}
	return tokens;
}
function parseDigSrv(stdout) {
	const line = stdout.split("\n").map((l) => l.trim()).find(Boolean);
	if (!line) return null;
	const parts = line.split(/\s+/).filter(Boolean);
	if (parts.length < 4) return null;
	const port = Number.parseInt(parts[2] ?? "", 10);
	const hostRaw = parts[3] ?? "";
	if (!Number.isFinite(port) || port <= 0) return null;
	const host = hostRaw.replace(/\.$/, "");
	if (!host) return null;
	return {
		host,
		port
	};
}
function parseTailscaleStatusIPv4s(stdout) {
	const parsed = stdout ? JSON.parse(stdout) : {};
	const out = [];
	const addIps = (value) => {
		if (!value || typeof value !== "object") return;
		const ips = value.TailscaleIPs;
		if (!Array.isArray(ips)) return;
		for (const ip of ips) {
			if (typeof ip !== "string") continue;
			const trimmed = ip.trim();
			if (trimmed && isTailnetIPv4(trimmed)) out.push(trimmed);
		}
	};
	addIps(parsed.Self);
	const peerObj = parsed.Peer;
	if (peerObj && typeof peerObj === "object") for (const peer of Object.values(peerObj)) addIps(peer);
	return [...new Set(out)];
}
function parseIntOrNull(value) {
	if (!value) return;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : void 0;
}
function parseTxtTokens(tokens) {
	const txt = {};
	for (const token of tokens) {
		const idx = token.indexOf("=");
		if (idx <= 0) continue;
		const key = token.slice(0, idx).trim();
		const value = decodeDnsSdEscapes(token.slice(idx + 1).trim());
		if (!key) continue;
		txt[key] = value;
	}
	return txt;
}
function parseDnsSdBrowse(stdout) {
	const instances = /* @__PURE__ */ new Set();
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (!line || !line.includes(GATEWAY_SERVICE_TYPE)) continue;
		if (!line.includes("Add")) continue;
		const match = line.match(/_openclaw-gw\._tcp\.?\s+(.+)$/);
		if (match?.[1]) instances.add(decodeDnsSdEscapes(match[1].trim()));
	}
	return Array.from(instances.values());
}
function parseDnsSdResolve(stdout, instanceName) {
	const decodedInstanceName = decodeDnsSdEscapes(instanceName);
	const beacon = { instanceName: decodedInstanceName };
	let txt = {};
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (line.includes("can be reached at")) {
			const match = line.match(/can be reached at\s+([^\s:]+):(\d+)/i);
			if (match?.[1]) beacon.host = match[1].replace(/\.$/, "");
			if (match?.[2]) beacon.port = parseIntOrNull(match[2]);
			continue;
		}
		if (line.startsWith("txt") || line.includes("txtvers=")) txt = parseTxtTokens(line.split(/\s+/).filter(Boolean));
	}
	beacon.txt = Object.keys(txt).length ? txt : void 0;
	if (txt.displayName) beacon.displayName = decodeDnsSdEscapes(txt.displayName);
	if (txt.lanHost) beacon.lanHost = txt.lanHost;
	if (txt.tailnetDns) beacon.tailnetDns = txt.tailnetDns;
	if (txt.cliPath) beacon.cliPath = txt.cliPath;
	beacon.gatewayPort = parseIntOrNull(txt.gatewayPort);
	beacon.sshPort = parseIntOrNull(txt.sshPort);
	if (txt.gatewayTls) {
		const raw = txt.gatewayTls.trim().toLowerCase();
		beacon.gatewayTls = raw === "1" || raw === "true" || raw === "yes";
	}
	if (txt.gatewayTlsSha256) beacon.gatewayTlsFingerprintSha256 = txt.gatewayTlsSha256;
	if (txt.role) beacon.role = txt.role;
	if (txt.transport) beacon.transport = txt.transport;
	if (!beacon.displayName) beacon.displayName = decodedInstanceName;
	return beacon;
}
async function discoverViaDnsSd(domain, timeoutMs, run) {
	const instances = parseDnsSdBrowse((await run([
		"dns-sd",
		"-B",
		GATEWAY_SERVICE_TYPE,
		domain
	], { timeoutMs })).stdout);
	const results = [];
	for (const instance of instances) {
		const parsed = parseDnsSdResolve((await run([
			"dns-sd",
			"-L",
			instance,
			GATEWAY_SERVICE_TYPE,
			domain
		], { timeoutMs })).stdout, instance);
		if (parsed) results.push({
			...parsed,
			domain
		});
	}
	return results;
}
async function discoverWideAreaViaTailnetDns(domain, timeoutMs, run) {
	if (!domain || domain === "local.") return [];
	const startedAt = Date.now();
	const remainingMs = () => timeoutMs - (Date.now() - startedAt);
	const tailscaleCandidates = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
	let ips = [];
	for (const candidate of tailscaleCandidates) try {
		ips = parseTailscaleStatusIPv4s((await run([
			candidate,
			"status",
			"--json"
		], { timeoutMs: Math.max(1, Math.min(700, remainingMs())) })).stdout);
		if (ips.length > 0) break;
	} catch {}
	if (ips.length === 0) return [];
	if (remainingMs() <= 0) return [];
	ips = ips.slice(0, 40);
	const probeName = `${GATEWAY_SERVICE_TYPE}.${domain.replace(/\.$/, "")}`;
	const concurrency = 6;
	let nextIndex = 0;
	let nameserver = null;
	let ptrs = [];
	const worker = async () => {
		while (nameserver === null) {
			const budget = remainingMs();
			if (budget <= 0) return;
			const i = nextIndex;
			nextIndex += 1;
			if (i >= ips.length) return;
			const ip = ips[i] ?? "";
			if (!ip) continue;
			try {
				const lines = parseDigShortLines((await run([
					"dig",
					"+short",
					"+time=1",
					"+tries=1",
					`@${ip}`,
					probeName,
					"PTR"
				], { timeoutMs: Math.max(1, Math.min(250, budget)) })).stdout);
				if (lines.length === 0) continue;
				nameserver = ip;
				ptrs = lines;
				return;
			} catch {}
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, () => worker()));
	if (!nameserver || ptrs.length === 0) return [];
	if (remainingMs() <= 0) return [];
	const nameserverArg = `@${String(nameserver)}`;
	const results = [];
	for (const ptr of ptrs) {
		const budget = remainingMs();
		if (budget <= 0) break;
		const ptrName = ptr.trim().replace(/\.$/, "");
		if (!ptrName) continue;
		const instanceName = ptrName.replace(/\.?_openclaw-gw\._tcp\..*$/, "");
		const srv = await run([
			"dig",
			"+short",
			"+time=1",
			"+tries=1",
			nameserverArg,
			ptrName,
			"SRV"
		], { timeoutMs: Math.max(1, Math.min(350, budget)) }).catch(() => null);
		const srvParsed = srv ? parseDigSrv(srv.stdout) : null;
		if (!srvParsed) continue;
		const txtBudget = remainingMs();
		if (txtBudget <= 0) {
			results.push({
				instanceName: instanceName || ptrName,
				displayName: instanceName || ptrName,
				domain,
				host: srvParsed.host,
				port: srvParsed.port
			});
			continue;
		}
		const txt = await run([
			"dig",
			"+short",
			"+time=1",
			"+tries=1",
			nameserverArg,
			ptrName,
			"TXT"
		], { timeoutMs: Math.max(1, Math.min(350, txtBudget)) }).catch(() => null);
		const txtTokens = txt ? parseDigTxt(txt.stdout) : [];
		const txtMap = txtTokens.length > 0 ? parseTxtTokens(txtTokens) : {};
		const beacon = {
			instanceName: instanceName || ptrName,
			displayName: txtMap.displayName || instanceName || ptrName,
			domain,
			host: srvParsed.host,
			port: srvParsed.port,
			txt: Object.keys(txtMap).length ? txtMap : void 0,
			gatewayPort: parseIntOrNull(txtMap.gatewayPort),
			sshPort: parseIntOrNull(txtMap.sshPort),
			tailnetDns: txtMap.tailnetDns || void 0,
			cliPath: txtMap.cliPath || void 0
		};
		if (txtMap.gatewayTls) {
			const raw = txtMap.gatewayTls.trim().toLowerCase();
			beacon.gatewayTls = raw === "1" || raw === "true" || raw === "yes";
		}
		if (txtMap.gatewayTlsSha256) beacon.gatewayTlsFingerprintSha256 = txtMap.gatewayTlsSha256;
		if (txtMap.role) beacon.role = txtMap.role;
		if (txtMap.transport) beacon.transport = txtMap.transport;
		results.push(beacon);
	}
	return results;
}
function parseAvahiBrowse(stdout) {
	const results = [];
	let current = null;
	for (const raw of stdout.split("\n")) {
		const line = raw.trimEnd();
		if (!line) continue;
		if (line.startsWith("=") && line.includes(GATEWAY_SERVICE_TYPE)) {
			if (current) results.push(current);
			const marker = ` ${GATEWAY_SERVICE_TYPE}`;
			const idx = line.indexOf(marker);
			const left = idx >= 0 ? line.slice(0, idx).trim() : line;
			const parts = left.split(/\s+/);
			const instanceName = parts.length > 3 ? parts.slice(3).join(" ") : left;
			current = {
				instanceName,
				displayName: instanceName
			};
			continue;
		}
		if (!current) continue;
		const trimmed = line.trim();
		if (trimmed.startsWith("hostname =")) {
			const match = trimmed.match(/hostname\s*=\s*\[([^\]]+)\]/);
			if (match?.[1]) current.host = match[1];
			continue;
		}
		if (trimmed.startsWith("port =")) {
			const match = trimmed.match(/port\s*=\s*\[(\d+)\]/);
			if (match?.[1]) current.port = parseIntOrNull(match[1]);
			continue;
		}
		if (trimmed.startsWith("txt =")) {
			const txt = parseTxtTokens(Array.from(trimmed.matchAll(/"([^"]*)"/g), (m) => m[1]));
			current.txt = Object.keys(txt).length ? txt : void 0;
			if (txt.displayName) current.displayName = txt.displayName;
			if (txt.lanHost) current.lanHost = txt.lanHost;
			if (txt.tailnetDns) current.tailnetDns = txt.tailnetDns;
			if (txt.cliPath) current.cliPath = txt.cliPath;
			current.gatewayPort = parseIntOrNull(txt.gatewayPort);
			current.sshPort = parseIntOrNull(txt.sshPort);
			if (txt.gatewayTls) {
				const raw = txt.gatewayTls.trim().toLowerCase();
				current.gatewayTls = raw === "1" || raw === "true" || raw === "yes";
			}
			if (txt.gatewayTlsSha256) current.gatewayTlsFingerprintSha256 = txt.gatewayTlsSha256;
			if (txt.role) current.role = txt.role;
			if (txt.transport) current.transport = txt.transport;
		}
	}
	if (current) results.push(current);
	return results;
}
async function discoverViaAvahi(domain, timeoutMs, run) {
	const args = [
		"avahi-browse",
		"-rt",
		GATEWAY_SERVICE_TYPE
	];
	if (domain && domain !== "local.") args.push("-d", domain.replace(/\.$/, ""));
	return parseAvahiBrowse((await run(args, { timeoutMs })).stdout).map((beacon) => ({
		...beacon,
		domain
	}));
}
async function discoverGatewayBeacons(opts = {}) {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const platform = opts.platform ?? process.platform;
	const run = opts.run ?? runCommandWithTimeout;
	const wideAreaDomain = resolveWideAreaDiscoveryDomain({ configDomain: opts.wideAreaDomain });
	const domainsRaw = Array.isArray(opts.domains) ? opts.domains : [];
	const defaultDomains = ["local.", ...wideAreaDomain ? [wideAreaDomain] : []];
	const domains = (domainsRaw.length > 0 ? domainsRaw : defaultDomains).map((d) => String(d).trim()).filter(Boolean).map((d) => d.endsWith(".") ? d : `${d}.`);
	try {
		if (platform === "darwin") {
			const discovered = (await Promise.allSettled(domains.map(async (domain) => await discoverViaDnsSd(domain, timeoutMs, run)))).flatMap((r) => r.status === "fulfilled" ? r.value : []);
			const wantsWideArea = wideAreaDomain ? domains.includes(wideAreaDomain) : false;
			const hasWideArea = wideAreaDomain ? discovered.some((b) => b.domain === wideAreaDomain) : false;
			if (wantsWideArea && !hasWideArea && wideAreaDomain) {
				const fallback = await discoverWideAreaViaTailnetDns(wideAreaDomain, timeoutMs, run).catch(() => []);
				return [...discovered, ...fallback];
			}
			return discovered;
		}
		if (platform === "linux") return (await Promise.allSettled(domains.map(async (domain) => await discoverViaAvahi(domain, timeoutMs, run)))).flatMap((r) => r.status === "fulfilled" ? r.value : []);
	} catch {
		return [];
	}
	return [];
}

//#endregion
export { discoverGatewayBeacons as t };