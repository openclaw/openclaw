// Operator-declared origins that may receive Google Generative AI credentials.
//
// The official origin stays the only default. A deployment that terminates the
// Google credential in its own reverse proxy (so the gateway holds only a
// placeholder) can name that proxy's exact origin in the process environment.

export const GOOGLE_GENERATIVE_AI_TRUSTED_ORIGINS_ENV =
  "OPENCLAW_GOOGLE_GENERATIVE_AI_TRUSTED_ORIGINS";

function isPrivateOrLoopbackIpv4Literal(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (!match) {
    return false;
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return false;
  }
  // The pattern guarantees four octets; the defaults only satisfy the type checker.
  const [first = -1, second = -1] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

/** Loopback or RFC 1918 IP literal; hostnames never qualify. */
export function isPrivateOrLoopbackIpLiteral(hostname: string): boolean {
  return hostname === "[::1]" || isPrivateOrLoopbackIpv4Literal(hostname);
}

/**
 * One entry is a bare origin: scheme, host and optional port, nothing else.
 * `https` is accepted for any host; plain `http` only for a loopback or private
 * IP literal, where the hop never leaves the operator's own network.
 */
function parseTrustedOrigin(entry: string): string | undefined {
  const url = URL.parse(entry);
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return undefined;
  }
  // Path, query, fragment and userinfo forms are refused rather than normalized
  // away, so an entry can never widen trust beyond what it literally names.
  const authority = entry.slice(url.protocol.length + 2);
  if (!entry.startsWith(`${url.protocol}//`) || /[/?#@\\]/u.test(authority)) {
    return undefined;
  }
  if (url.protocol === "http:" && !isPrivateOrLoopbackIpLiteral(url.hostname)) {
    return undefined;
  }
  return url.origin;
}

export function resolveTrustedGoogleGenerativeAiOrigins(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const entry of (env[GOOGLE_GENERATIVE_AI_TRUSTED_ORIGINS_ENV] ?? "").split(/[\s,]+/u)) {
    const origin = entry ? parseTrustedOrigin(entry) : undefined;
    if (origin) {
      origins.add(origin);
    }
  }
  return origins;
}

/** True when the base URL's exact origin was declared by the operator. */
export function isOperatorTrustedGoogleGenerativeAiBaseUrl(
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const url = baseUrl ? URL.parse(baseUrl) : null;
  if (!url || url.username || url.password) {
    return false;
  }
  return resolveTrustedGoogleGenerativeAiOrigins(env).has(url.origin);
}

/** An operator-declared origin on a loopback or private IP literal. */
export function isOperatorTrustedPrivateGoogleGenerativeAiBaseUrl(
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const url = baseUrl ? URL.parse(baseUrl) : null;
  return (
    url !== null &&
    isPrivateOrLoopbackIpLiteral(url.hostname) &&
    isOperatorTrustedGoogleGenerativeAiBaseUrl(baseUrl, env)
  );
}
