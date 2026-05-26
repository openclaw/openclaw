import { r as theme, t as colorize } from "./theme-D58JpUfy.js";
import { n as parseTimeoutMsWithFallback } from "./parse-timeout-91AFhn8L.js";
import { n as buildGatewayDiscoveryTarget } from "./gateway-discovery-targets-FNcBbrXr.js";
//#region src/cli/gateway-cli/discover.ts
function parseDiscoverTimeoutMs(raw, fallbackMs) {
	return parseTimeoutMsWithFallback(raw, fallbackMs, { invalidType: "error" });
}
function pickBeaconHost(beacon) {
	return buildGatewayDiscoveryTarget(beacon).endpoint?.host ?? null;
}
function pickGatewayPort(beacon) {
	return buildGatewayDiscoveryTarget(beacon).endpoint?.port ?? null;
}
function dedupeBeacons(beacons) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const b of beacons) {
		const host = pickBeaconHost(b) ?? "";
		const key = [
			b.domain ?? "",
			b.instanceName ?? "",
			b.displayName ?? "",
			host,
			String(b.port ?? ""),
			String(b.gatewayPort ?? "")
		].join("|");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(b);
	}
	return out;
}
function renderBeaconLines(beacon, rich) {
	const target = buildGatewayDiscoveryTarget(beacon);
	const lines = [`- ${colorize(rich, theme.accentBright, target.title)} ${colorize(rich, theme.muted, target.domain)}`];
	if (beacon.tailnetDns) lines.push(`  ${colorize(rich, theme.info, "tailnet")}: ${beacon.tailnetDns}`);
	if (beacon.lanHost) lines.push(`  ${colorize(rich, theme.info, "lan")}: ${beacon.lanHost}`);
	if (beacon.host) lines.push(`  ${colorize(rich, theme.info, "host")}: ${beacon.host}`);
	if (target.wsUrl) lines.push(`  ${colorize(rich, theme.muted, "ws")}: ${colorize(rich, theme.command, target.wsUrl)}`);
	if (beacon.role) lines.push(`  ${colorize(rich, theme.muted, "role")}: ${beacon.role}`);
	if (beacon.transport) lines.push(`  ${colorize(rich, theme.muted, "transport")}: ${beacon.transport}`);
	if (beacon.gatewayTls) {
		const fingerprint = beacon.gatewayTlsFingerprintSha256 ? `sha256 ${beacon.gatewayTlsFingerprintSha256}` : "enabled";
		lines.push(`  ${colorize(rich, theme.muted, "tls")}: ${fingerprint}`);
	}
	if (target.endpoint && target.sshPort) {
		const ssh = `ssh -N -L 18789:127.0.0.1:18789 <user>@${target.endpoint.host} -p ${target.sshPort}`;
		lines.push(`  ${colorize(rich, theme.muted, "ssh")}: ${colorize(rich, theme.command, ssh)}`);
	}
	return lines;
}
//#endregion
export { dedupeBeacons, parseDiscoverTimeoutMs, pickBeaconHost, pickGatewayPort, renderBeaconLines };
