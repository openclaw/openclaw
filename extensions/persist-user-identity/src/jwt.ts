import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JWTPayload = {
  sub?: string;
  given_name?: string;
  family_name?: string;
  name?: string;
  email?: string;
  exp?: number;
  iss?: string;
  aud?: string | string[];
  [key: string]: unknown;
};

export type AuthConfig = {
  mode: "jwt-hs256" | "verify-endpoint" | "passcode-endpoint";
  jwtSecret?: string;
  verifyEndpoint?: string;
  passcodeVerifyUrl?: string;
  userLookupUrl?: string;
  apiToken?: string;
  issuer?: string;
  audience?: string;
};

export type UserLookupResult = {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
};

/**
 * Normalized result from any verification method.
 */
export type VerifiedIdentity = {
  externalId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  raw: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a user-provided token and return a normalized identity.
 * Supports HS256 JWT verification and remote endpoint verification.
 */
export async function verifyToken(
  token: string,
  config: AuthConfig,
): Promise<VerifiedIdentity | null> {
  if (config.mode === "jwt-hs256" && config.jwtSecret) {
    return verifyHS256(token, config);
  }
  if (config.mode === "verify-endpoint" && config.verifyEndpoint) {
    return verifyViaEndpoint(token, config.verifyEndpoint);
  }
  if (config.mode === "passcode-endpoint" && config.passcodeVerifyUrl && /^\d{4,10}$/.test(token)) {
    return verifyViaPasscode(token, undefined, config);
  }
  return null;
}

// ---------------------------------------------------------------------------
// HS256 JWT — zero external dependencies, uses Node built-in crypto
// ---------------------------------------------------------------------------

function verifyHS256(token: string, config: AuthConfig): VerifiedIdentity | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [header, payload, signature] = parts;

  // Verify signature
  const expected = createHmac("sha256", config.jwtSecret!)
    .update(`${header}.${payload}`)
    .digest("base64url");

  const sigBuf = Buffer.from(signature, "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  let decoded: JWTPayload;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as JWTPayload;
  } catch {
    return null;
  }

  // Check expiry
  if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  // Check issuer
  if (config.issuer && decoded.iss !== config.issuer) {
    return null;
  }

  // Check audience
  if (config.audience) {
    const aud = Array.isArray(decoded.aud) ? decoded.aud : [decoded.aud];
    if (!aud.includes(config.audience)) {
      return null;
    }
  }

  // Extract identity — require `sub` claim
  if (!decoded.sub) {
    return null;
  }

  const nameParts = decoded.name?.split(" ") ?? [];
  return {
    externalId: decoded.sub,
    firstName: decoded.given_name ?? nameParts[0],
    lastName: decoded.family_name ?? (nameParts.slice(1).join(" ") || undefined),
    email: decoded.email,
    raw: decoded,
  };
}

// ---------------------------------------------------------------------------
// Remote endpoint — POST { token } → { user_id, first_name, last_name }
// ---------------------------------------------------------------------------

async function verifyViaEndpoint(
  token: string,
  endpoint: string,
): Promise<VerifiedIdentity | null> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    const externalId = (data.user_id as string) ?? (data.sub as string);
    if (!externalId) {
      return null;
    }
    return {
      externalId,
      firstName: data.first_name as string | undefined,
      lastName: data.last_name as string | undefined,
      email: data.email as string | undefined,
      raw: data,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Passcode endpoint — POST { code, user_identifier, channel } → identity
// ---------------------------------------------------------------------------

export async function verifyViaPasscode(
  code: string,
  userIdentifier: string | undefined,
  config: AuthConfig,
): Promise<VerifiedIdentity | null> {
  if (!config.passcodeVerifyUrl) {
    return null;
  }
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiToken) {
      headers["Authorization"] = `Bearer ${config.apiToken}`;
    }
    const res = await fetch(config.passcodeVerifyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        code,
        user_identifier: userIdentifier ?? "",
        channel: "openclaw",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    const externalId = (data.user_id as string) ?? (data.sub as string);
    if (!externalId) {
      return null;
    }
    return {
      externalId,
      firstName: data.first_name as string | undefined,
      lastName: data.last_name as string | undefined,
      email: data.email as string | undefined,
      raw: data,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// User lookup by name — GET /api/ext/users/search?q=<name>
// ---------------------------------------------------------------------------

export async function lookupUserByName(
  name: string,
  config: AuthConfig,
): Promise<UserLookupResult[]> {
  if (!config.userLookupUrl) {
    return [];
  }
  try {
    const url = `${config.userLookupUrl}?q=${encodeURIComponent(name)}`;
    const headers: Record<string, string> = {};
    if (config.apiToken) {
      headers["Authorization"] = `Bearer ${config.apiToken}`;
    }
    const res = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(data)) {
      return [];
    }
    return data
      .filter((r) => r.user_id && r.first_name)
      .map((r) => ({
        userId: r.user_id as string,
        firstName: r.first_name as string,
        lastName: (r.last_name as string) ?? "",
        email: (r.email as string) ?? "",
      }));
  } catch {
    return [];
  }
}
