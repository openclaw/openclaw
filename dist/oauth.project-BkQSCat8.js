import { d as TIER_STANDARD, i as CODE_ASSIST_ENDPOINT_PROD, o as LOAD_CODE_ASSIST_ENDPOINTS, p as USERINFO_URL, u as TIER_LEGACY } from "./oauth.shared-BD6M390i.js";
import { t as fetchWithTimeout } from "./oauth.http-CWexeY83.js";
//#region extensions/google/oauth.project.ts
const LOAD_CODE_ASSIST_METADATA = {
	ideType: "IDE_UNSPECIFIED",
	platform: "PLATFORM_UNSPECIFIED",
	pluginType: "GEMINI"
};
async function getUserEmail(accessToken) {
	try {
		const response = await fetchWithTimeout(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
		if (response.ok) return (await response.json()).email;
	} catch {}
}
function isVpcScAffected(payload) {
	if (!payload || typeof payload !== "object") return false;
	const error = payload.error;
	if (!error || typeof error !== "object") return false;
	const details = error.details;
	if (!Array.isArray(details)) return false;
	return details.some((item) => typeof item === "object" && item && item.reason === "SECURITY_POLICY_VIOLATED");
}
function getDefaultTier(allowedTiers) {
	if (!allowedTiers?.length) return { id: TIER_LEGACY };
	return allowedTiers.find((tier) => tier.isDefault) ?? { id: "legacy-tier" };
}
async function pollOperation(endpoint, operationName, headers) {
	for (let attempt = 0; attempt < 24; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5e3));
		const response = await fetchWithTimeout(`${endpoint}/v1internal/${operationName}`, { headers });
		if (!response.ok) continue;
		const data = await response.json();
		if (data.done) return data;
	}
	throw new Error("Operation polling timeout");
}
async function resolveGoogleOAuthIdentity(accessToken) {
	return {
		email: await getUserEmail(accessToken),
		projectId: await discoverProject(accessToken)
	};
}
async function resolveGooglePersonalOAuthIdentity(accessToken) {
	return { email: await getUserEmail(accessToken) };
}
async function discoverProject(accessToken) {
	const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": `gl-node/${process.versions.node}`,
		"Client-Metadata": JSON.stringify(LOAD_CODE_ASSIST_METADATA)
	};
	const loadBody = {
		...envProject ? { cloudaicompanionProject: envProject } : {},
		metadata: {
			...LOAD_CODE_ASSIST_METADATA,
			...envProject ? { duetProject: envProject } : {}
		}
	};
	let data = {};
	let activeEndpoint = CODE_ASSIST_ENDPOINT_PROD;
	let loadError;
	for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) try {
		const response = await fetchWithTimeout(`${endpoint}/v1internal:loadCodeAssist`, {
			method: "POST",
			headers,
			body: JSON.stringify(loadBody)
		});
		if (!response.ok) {
			if (isVpcScAffected(await response.json().catch(() => null))) {
				data = { currentTier: { id: TIER_STANDARD } };
				activeEndpoint = endpoint;
				loadError = void 0;
				break;
			}
			loadError = /* @__PURE__ */ new Error(`loadCodeAssist failed: ${response.status} ${response.statusText}`);
			continue;
		}
		data = await response.json();
		activeEndpoint = endpoint;
		loadError = void 0;
		break;
	} catch (err) {
		loadError = err instanceof Error ? err : new Error("loadCodeAssist failed", { cause: err });
	}
	if (!(Boolean(data.currentTier) || Boolean(data.cloudaicompanionProject) || Boolean(data.allowedTiers?.length)) && loadError) {
		if (envProject) return envProject;
		throw loadError;
	}
	if (data.currentTier) {
		const project = data.cloudaicompanionProject;
		if (typeof project === "string" && project) return project;
		if (typeof project === "object" && project?.id) return project.id;
		if (envProject) return envProject;
		throw new Error("This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.");
	}
	const tierId = getDefaultTier(data.allowedTiers)?.id || "free-tier";
	if (tierId !== "free-tier" && !envProject) throw new Error("This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.");
	const onboardBody = {
		tierId,
		metadata: { ...LOAD_CODE_ASSIST_METADATA }
	};
	if (tierId !== "free-tier" && envProject) {
		onboardBody.cloudaicompanionProject = envProject;
		onboardBody.metadata.duetProject = envProject;
	}
	const onboardResponse = await fetchWithTimeout(`${activeEndpoint}/v1internal:onboardUser`, {
		method: "POST",
		headers,
		body: JSON.stringify(onboardBody)
	});
	if (!onboardResponse.ok) throw new Error(`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}`);
	let lro = await onboardResponse.json();
	if (!lro.done && lro.name) lro = await pollOperation(activeEndpoint, lro.name, headers);
	const projectId = lro.response?.cloudaicompanionProject?.id;
	if (projectId) return projectId;
	if (envProject) return envProject;
	throw new Error("Could not discover or provision a Google Cloud project. Set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.");
}
//#endregion
export { resolveGooglePersonalOAuthIdentity as n, resolveGoogleOAuthIdentity as t };
