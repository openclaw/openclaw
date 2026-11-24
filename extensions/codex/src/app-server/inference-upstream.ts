import { generateSecureToken } from "openclaw/plugin-sdk/secure-random-runtime";
import type { SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import type { CodexResponsesOAuth } from "./responses-oauth.js";

export type CodexInferenceUpstreamOptions = {
  upstream: URL;
  oauth?: CodexResponsesOAuth;
  preserveAzureUrlFeatures?: boolean;
  preserveCodexBackendRoutes?: boolean;
};

/** Freeze the provider destination and its authenticated private route together. */
export function createCodexInferenceUpstream(params: CodexInferenceUpstreamOptions) {
  const upstream = new URL(params.upstream);
  if (upstream.protocol !== "https:" || upstream.username || upstream.password || upstream.hash) {
    throw new Error("Codex inference requires a credential-free HTTPS upstream URL");
  }
  if (params.oauth && upstream.href.replace(/\/$/, "") !== "https://api.openai.com/v1") {
    throw new Error("ChatGPT subscription sharing requires the public Responses endpoint");
  }
  // Match provider fake-IP routing without allowing other private destinations.
  const policy = {
    allowRfc2544BenchmarkRange: true,
    allowIpv6UniqueLocalRange: true,
    hostnameAllowlist: [upstream.hostname],
  } satisfies SsrFPolicy;
  const upstreamPath = upstream.pathname.replace(/\/+$/, "");
  // Preserve native Azure feature detection and the Guardian backend suffix through loopback.
  const pathPrefix =
    "/" +
    generateSecureToken({ bytes: 32, redact: true }) +
    (params.preserveAzureUrlFeatures ? "/azure-api." : "") +
    upstreamPath +
    (params.preserveCodexBackendRoutes && !upstreamPath.endsWith("/backend-api/codex")
      ? "/backend-api/codex"
      : params.preserveCodexBackendRoutes === false && upstreamPath.endsWith("/backend-api/codex")
        ? "/native-responses"
        : "");
  return { upstream, upstreamPath, pathPrefix, policy };
}
