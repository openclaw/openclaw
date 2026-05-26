import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { n as buildGatewayConnectionDetails, r as callGateway } from "./call-t1U2G3yY.js";
import { t as note } from "./note-Dg2Luaaq.js";
import { t as collectChannelStatusIssues } from "./channels-status-issues-C_XpqXR-.js";
import { n as formatHealthCheckFailure } from "./health-format-DaSqSjzQ.js";
//#region src/commands/doctor-gateway-health.ts
function isGatewayCallTimeout(message) {
	return /^gateway timeout after \d+ms(?:\n|$)/.test(message);
}
function noteCliGatewayVersionSkew(status) {
	const gatewayVersion = status?.runtimeVersion?.trim();
	if (!gatewayVersion || gatewayVersion === VERSION) return;
	note([
		`This command is OpenClaw ${VERSION}; the running Gateway is OpenClaw ${gatewayVersion}.`,
		"Check `openclaw --version`, `which openclaw`, and `openclaw gateway status --deep`.",
		"If this mismatch is unexpected, update PATH so `openclaw` points to the version you want, or reinstall the Gateway service from that same OpenClaw install."
	].join("\n"), "OpenClaw version mismatch");
}
async function checkGatewayHealth(params) {
	const gatewayDetails = buildGatewayConnectionDetails({ config: params.cfg });
	const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 1e4;
	let healthOk = false;
	let status;
	try {
		status = await callGateway({
			method: "status",
			params: { includeChannelSummary: false },
			timeoutMs,
			config: params.cfg
		});
		healthOk = true;
		noteCliGatewayVersionSkew(status);
	} catch (err) {
		if (String(err).includes("gateway closed")) {
			note("Gateway not running.", "Gateway");
			note(gatewayDetails.message, "Gateway connection");
		} else params.runtime.error(formatHealthCheckFailure(err));
	}
	if (healthOk) try {
		const issues = collectChannelStatusIssues(await callGateway({
			method: "channels.status",
			params: {
				probe: true,
				timeoutMs: 5e3
			},
			timeoutMs: 6e3
		}));
		if (issues.length > 0) note(issues.map((issue) => `- ${issue.channel} ${issue.accountId}: ${issue.message}${issue.fix ? ` (${issue.fix})` : ""}`).join("\n"), "Channel warnings");
	} catch {}
	return {
		healthOk,
		status
	};
}
async function probeGatewayMemoryStatus(params) {
	const timeoutMs = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : 8e3;
	try {
		const payload = await callGateway({
			method: "doctor.memory.status",
			params: { probe: false },
			timeoutMs,
			config: params.cfg
		});
		const gatewayChecked = payload.embedding.checked !== false;
		return {
			checked: gatewayChecked,
			ready: payload.embedding.ok,
			error: payload.embedding.error,
			skipped: !gatewayChecked
		};
	} catch (err) {
		const message = formatErrorMessage(err);
		if (isGatewayCallTimeout(message)) return {
			checked: false,
			ready: false,
			error: `gateway memory probe timed out: ${message}`,
			skipped: false
		};
		return {
			checked: true,
			ready: false,
			error: `gateway memory probe unavailable: ${message}`,
			skipped: false
		};
	}
}
//#endregion
export { checkGatewayHealth, probeGatewayMemoryStatus };
