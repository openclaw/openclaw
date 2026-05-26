import { x as ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist } from "./ssrf-DdDeGa5L.js";
import { a as withTrustedEnvProxyGuardedFetchMode, i as withStrictGuardedFetchMode, n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
//#region src/agents/tools/web-guarded-fetch.ts
const WEB_TOOLS_SELF_HOSTED_NETWORK_SSRF_POLICY = {
	dangerouslyAllowPrivateNetwork: true,
	allowRfc2544BenchmarkRange: true,
	allowIpv6UniqueLocalRange: true
};
function resolveTimeoutMs(params) {
	if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) return params.timeoutMs;
	if (typeof params.timeoutSeconds === "number" && Number.isFinite(params.timeoutSeconds)) return params.timeoutSeconds * 1e3;
}
async function fetchWithWebToolsNetworkGuard(params) {
	const { timeoutSeconds, useEnvProxy, ...rest } = params;
	const resolved = {
		...rest,
		timeoutMs: resolveTimeoutMs({
			timeoutMs: rest.timeoutMs,
			timeoutSeconds
		})
	};
	return fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(resolved) : withStrictGuardedFetchMode(resolved));
}
async function withWebToolsNetworkGuard(params, run) {
	const { response, finalUrl, release } = await fetchWithWebToolsNetworkGuard(params);
	try {
		return await run({
			response,
			finalUrl
		});
	} finally {
		await release();
	}
}
async function withTrustedWebToolsEndpoint(params, run) {
	const trustedPolicy = ssrfPolicyFromHttpBaseUrlFakeIpHostnameAllowlist(params.url) ?? {};
	return await withWebToolsNetworkGuard({
		...params,
		policy: trustedPolicy,
		useEnvProxy: true
	}, run);
}
async function withSelfHostedWebToolsEndpoint(params, run) {
	return await withWebToolsNetworkGuard({
		...params,
		policy: WEB_TOOLS_SELF_HOSTED_NETWORK_SSRF_POLICY,
		useEnvProxy: true
	}, run);
}
async function withStrictWebToolsEndpoint(params, run) {
	return await withWebToolsNetworkGuard(params, run);
}
//#endregion
export { withTrustedWebToolsEndpoint as i, withSelfHostedWebToolsEndpoint as n, withStrictWebToolsEndpoint as r, fetchWithWebToolsNetworkGuard as t };
