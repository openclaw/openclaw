import { normalizeEmbeddedAgentRuntime } from "../pi-embedded-runner/runtime.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
const CODEX_HARNESS_AUTH_PROVIDER = "openai-codex";
function resolveHarnessAuthProvider(params) {
    const harnessId = normalizeEmbeddedAgentRuntime(params.harnessId);
    const runtime = normalizeEmbeddedAgentRuntime(params.harnessRuntime);
    return harnessId === "codex" || runtime === "codex" ? CODEX_HARNESS_AUTH_PROVIDER : undefined;
}
export function buildAgentRuntimeAuthPlan(params) {
    const aliasLookupParams = {
        config: params.config,
        workspaceDir: params.workspaceDir,
    };
    const providerForAuth = resolveProviderIdForAuth(params.provider, aliasLookupParams);
    const authProfileProviderForAuth = resolveProviderIdForAuth(params.authProfileProvider ?? params.provider, aliasLookupParams);
    const harnessAuthProvider = resolveHarnessAuthProvider(params);
    const harnessProviderForAuth = harnessAuthProvider
        ? resolveProviderIdForAuth(harnessAuthProvider, aliasLookupParams)
        : undefined;
    const harnessCanForwardProfile = params.allowHarnessAuthProfileForwarding !== false &&
        harnessProviderForAuth &&
        harnessProviderForAuth === authProfileProviderForAuth;
    const canForwardProfile = providerForAuth === authProfileProviderForAuth || harnessCanForwardProfile;
    return {
        providerForAuth,
        authProfileProviderForAuth,
        ...(harnessProviderForAuth ? { harnessAuthProvider: harnessProviderForAuth } : {}),
        ...(canForwardProfile ? { forwardedAuthProfileId: params.sessionAuthProfileId } : {}),
    };
}
