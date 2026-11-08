import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";

// Ships and proxies can echo the Urbit session cookie as bare `name=value` text
// that the shared redactor's structured patterns do not see, and the runtime-issued
// cookie cannot enter the registered-secret-value mechanism from a plugin. The
// credential-owning plugin masks the known `urbauth-` reflection form itself.
const URBIT_COOKIE_REFLECTION_RE = /\burbauth-[a-z0-9~-]+=[^\s"'(),;]+/gi;

export function redactUrbitErrorText(text: string): string {
  return redactToolPayloadText(text).replace(URBIT_COOKIE_REFLECTION_RE, "***");
}
