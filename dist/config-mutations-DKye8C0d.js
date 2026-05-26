import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as mutateConfigFile } from "./mutate-DLC8bveh.js";
import { S as BrowserResourceExhaustedError, T as BrowserValidationError, _ as BrowserConflictError, n as assertCdpEndpointAllowed } from "./cdp.helpers-D-78hr0t.js";
import { c as deriveDefaultBrowserCdpPortRange, n as resolveBrowserConfig } from "./config-F211Ihcd.js";
import "./config-CblF4FCf.js";
import "./errors-BUgcAIYJ.js";
const PROFILE_NAME_REGEX = /^[a-z0-9][a-z0-9-]*$/;
function isValidProfileName(name) {
	if (!name || name.length > 64) return false;
	return PROFILE_NAME_REGEX.test(name);
}
function allocateCdpPort(usedPorts, range) {
	const start = range?.start ?? 18800;
	const end = range?.end ?? 18899;
	if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0) return null;
	if (start > end) return null;
	for (let port = start; port <= end; port++) if (!usedPorts.has(port)) return port;
	return null;
}
function getUsedPorts(profiles) {
	if (!profiles) return /* @__PURE__ */ new Set();
	const used = /* @__PURE__ */ new Set();
	for (const profile of Object.values(profiles)) {
		if (typeof profile.cdpPort === "number") {
			used.add(profile.cdpPort);
			continue;
		}
		const rawUrl = profile.cdpUrl?.trim();
		if (!rawUrl) continue;
		try {
			const parsed = new URL(rawUrl);
			const port = parsed.port && Number.parseInt(parsed.port, 10) > 0 ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
			if (!Number.isNaN(port) && port > 0 && port <= 65535) used.add(port);
		} catch {}
	}
	return used;
}
const PROFILE_COLORS = [
	"#FF4500",
	"#0066CC",
	"#00AA00",
	"#9933FF",
	"#FF6699",
	"#00CCCC",
	"#FF9900",
	"#6666FF",
	"#CC3366",
	"#339966"
];
function allocateColor(usedColors) {
	for (const color of PROFILE_COLORS) if (!usedColors.has(color.toUpperCase())) return color;
	return PROFILE_COLORS[usedColors.size % PROFILE_COLORS.length] ?? PROFILE_COLORS[0];
}
function getUsedColors(profiles) {
	if (!profiles) return /* @__PURE__ */ new Set();
	return new Set(Object.values(profiles).map((p) => p.color.toUpperCase()));
}
//#endregion
//#region extensions/browser/src/browser/config-mutations.ts
const cdpPortRange = (resolved) => {
	const start = resolved.cdpPortRangeStart;
	const end = resolved.cdpPortRangeEnd;
	if (typeof start === "number" && Number.isFinite(start) && Number.isInteger(start) && typeof end === "number" && Number.isFinite(end) && Number.isInteger(end) && start > 0 && end >= start && end <= 65535) return {
		start,
		end
	};
	return deriveDefaultBrowserCdpPortRange(resolved.controlPort);
};
async function persistBrowserControlCredential(credential) {
	await mutateConfigFile({
		afterWrite: { mode: "auto" },
		mutate: (draft) => {
			draft.gateway = {
				...draft.gateway,
				auth: {
					...draft.gateway?.auth,
					[credential.kind]: credential.value
				}
			};
		}
	});
}
async function createBrowserProfileConfig(params) {
	return (await mutateConfigFile({
		afterWrite: { mode: "auto" },
		mutate: async (draft) => {
			const rawDraftBrowser = draft.browser;
			const draftCdpPortRangeEnd = typeof rawDraftBrowser?.cdpPortRangeEnd === "number" ? rawDraftBrowser.cdpPortRangeEnd : void 0;
			const useRebasedPortRange = draft.gateway?.port !== void 0 || draft.browser?.cdpPortRangeStart !== void 0 || draftCdpPortRangeEnd !== void 0;
			const latestResolved = resolveBrowserConfig({
				...params.resolved,
				...draft.browser,
				profiles: draft.browser?.profiles ?? params.resolved.profiles
			}, draft);
			const latestRootResolved = resolveBrowserConfig(draft.browser, draft);
			const latestProfileSource = useRebasedPortRange ? latestRootResolved : latestResolved;
			const latestProfiles = draft.browser?.profiles ?? {};
			if (params.name in latestProfiles || params.name in latestProfileSource.profiles) throw new BrowserConflictError(`profile "${params.name}" already exists`);
			const profileColor = params.color ?? allocateColor(getUsedColors(latestProfileSource.profiles));
			let nextProfileConfig;
			if (params.parsedCdpUrl) {
				try {
					await assertCdpEndpointAllowed(params.parsedCdpUrl, latestResolved.ssrfPolicy);
				} catch (err) {
					throw new BrowserValidationError(formatErrorMessage(err));
				}
				nextProfileConfig = {
					cdpUrl: params.parsedCdpUrl,
					...params.driver ? { driver: params.driver } : {},
					color: profileColor
				};
			} else if (params.driver === "existing-session") nextProfileConfig = {
				driver: params.driver,
				attachOnly: true,
				...params.userDataDir ? { userDataDir: params.userDataDir } : {},
				color: profileColor
			};
			else {
				const usedPorts = getUsedPorts(latestProfileSource.profiles);
				const rangeSource = useRebasedPortRange ? latestRootResolved : params.resolved;
				const cdpPort = allocateCdpPort(usedPorts, cdpPortRange({
					controlPort: rangeSource.controlPort,
					cdpPortRangeStart: rangeSource.cdpPortRangeStart,
					cdpPortRangeEnd: draftCdpPortRangeEnd ?? rangeSource.cdpPortRangeEnd
				}));
				if (cdpPort === null) throw new BrowserResourceExhaustedError("no available CDP ports in range");
				nextProfileConfig = {
					cdpPort,
					...params.driver ? { driver: params.driver } : {},
					color: profileColor
				};
			}
			draft.browser = {
				...draft.browser,
				profiles: {
					...draft.browser?.profiles,
					[params.name]: nextProfileConfig
				}
			};
			return nextProfileConfig;
		}
	})).result;
}
async function deleteBrowserProfileConfig(name) {
	await mutateConfigFile({
		afterWrite: { mode: "auto" },
		mutate: (draft) => {
			const { [name]: _removed, ...remainingProfiles } = draft.browser?.profiles ?? {};
			const nextBrowser = {
				...draft.browser,
				profiles: remainingProfiles
			};
			if (nextBrowser.defaultProfile === name) delete nextBrowser.defaultProfile;
			draft.browser = nextBrowser;
		}
	});
}
//#endregion
export { isValidProfileName as i, deleteBrowserProfileConfig as n, persistBrowserControlCredential as r, createBrowserProfileConfig as t };
