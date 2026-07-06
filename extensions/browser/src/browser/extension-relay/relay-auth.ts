/**
 * Extension relay auth material.
 *
 * The relay token is derived (HMAC-SHA256) from the gateway auth material so
 * pairing never hands the raw gateway credential to Chrome and no new secret
 * needs persisting. Rotating gateway auth rotates the relay token.
 *
 * Imports resolveGatewayAuth directly (not control-auth.ts) because config.ts
 * consumes this module and control-auth pulls config-mutations back in — a cycle.
 */
import crypto from "node:crypto";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveGatewayAuth } from "../../gateway/auth.js";

const RELAY_TOKEN_CONTEXT = "openclaw-extension-relay-v2";

/** Derive the extension relay bearer token from gateway auth material. */
export function deriveExtensionRelayToken(material: string): string {
  return crypto.createHmac("sha256", material).update(RELAY_TOKEN_CONTEXT).digest("hex");
}

/**
 * Resolve the relay token for this install, or null when no gateway auth
 * material exists yet (gateway startup auto-generates it on first run).
 */
export function resolveExtensionRelayToken(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const auth = resolveGatewayAuth({
    authConfig: cfg?.gateway?.auth,
    env,
    tailscaleMode: cfg?.gateway?.tailscale?.mode,
  });
  const material = normalizeOptionalString(auth.token) ?? normalizeOptionalString(auth.password);
  if (!material) {
    return null;
  }
  return deriveExtensionRelayToken(material);
}

/** Constant-time token comparison. */
export function extensionRelayTokenMatches(expected: string, candidate: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const candidateBuf = Buffer.from(candidate);
  if (expectedBuf.length !== candidateBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, candidateBuf);
}
