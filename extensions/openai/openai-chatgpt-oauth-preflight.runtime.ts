import {
  runHttpTlsPreflight,
  type HttpTlsPreflightOptions,
} from "openclaw/plugin-sdk/provider-http";

const OPENAI_AUTH_PROBE_URL =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=openclaw-preflight&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile+email";

export function runOpenAIOAuthTlsPreflight(options?: HttpTlsPreflightOptions) {
  return runHttpTlsPreflight(OPENAI_AUTH_PROBE_URL, options);
}
