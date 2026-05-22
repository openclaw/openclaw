import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { t as safeParseJsonWithSchema } from "./zod-parse-ByT__FkO.js";
import { z } from "zod";
//#region src/shared/gateway-bind-url.ts
function resolveGatewayBindUrl(params) {
	const bind = params.bind ?? "loopback";
	if (bind === "custom") {
		const host = normalizeOptionalString(params.customBindHost);
		if (host) return {
			url: `${params.scheme}://${host}:${params.port}`,
			source: "gateway.bind=custom"
		};
		return { error: "gateway.bind=custom requires gateway.customBindHost." };
	}
	if (bind === "tailnet") {
		const host = params.pickTailnetHost();
		if (host) return {
			url: `${params.scheme}://${host}:${params.port}`,
			source: "gateway.bind=tailnet"
		};
		return { error: "gateway.bind=tailnet set, but no tailnet IP was found." };
	}
	if (bind === "lan") {
		const host = params.pickLanHost();
		if (host) return {
			url: `${params.scheme}://${host}:${params.port}`,
			source: "gateway.bind=lan"
		};
		return { error: "gateway.bind=lan set, but no private LAN IP was found." };
	}
	return null;
}
//#endregion
//#region src/shared/tailscale-status.ts
const TAILSCALE_STATUS_COMMAND_CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
const TailscaleStatusSchema = z.object({ Self: z.object({
	DNSName: z.string().optional(),
	TailscaleIPs: z.array(z.string()).optional()
}).optional() });
function parsePossiblyNoisyStatus(raw) {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	return safeParseJsonWithSchema(TailscaleStatusSchema, raw.slice(start, end + 1));
}
function extractTailnetHostFromStatusJson(raw) {
	const parsed = parsePossiblyNoisyStatus(raw);
	const dns = parsed?.Self?.DNSName;
	if (dns && dns.length > 0) return dns.replace(/\.$/, "");
	const ips = parsed?.Self?.TailscaleIPs ?? [];
	return ips.length > 0 ? ips[0] ?? null : null;
}
async function resolveTailnetHostWithRunner(runCommandWithTimeout) {
	if (!runCommandWithTimeout) return null;
	for (const candidate of TAILSCALE_STATUS_COMMAND_CANDIDATES) try {
		const result = await runCommandWithTimeout([
			candidate,
			"status",
			"--json"
		], { timeoutMs: 5e3 });
		if (result.code !== 0) continue;
		const raw = result.stdout.trim();
		if (!raw) continue;
		const host = extractTailnetHostFromStatusJson(raw);
		if (host) return host;
	} catch {
		continue;
	}
	return null;
}
//#endregion
export { resolveGatewayBindUrl as n, resolveTailnetHostWithRunner as t };
