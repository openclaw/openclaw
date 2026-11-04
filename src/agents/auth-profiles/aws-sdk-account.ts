/**
 * Stored account for a provider's AWS SDK route.
 *
 * An `aws-sdk` route holds no secret: every request resolves credentials
 * through the AWS SDK default credential chain. The auth store still owns the
 * account, because its record is what an automation binds and what signing out
 * revokes — an authorization is the lifetime of an owner-issued record, not an
 * AWS principal. The credential therefore carries a non-secret marker only.
 */
import { AWS_SDK_CREDENTIALS_MARKER } from "../model-auth-markers.js";
import type { ApiKeyCredential, AuthProfileCredential } from "./types.js";

/** Account id for a provider's AWS SDK route. */
export function resolveAwsSdkAuthProfileId(provider: string): string {
  return `${provider}:aws-sdk`;
}

/** Credential for an AWS SDK account: a marker, never AWS key material. */
export function buildAwsSdkAuthProfileCredential(provider: string): ApiKeyCredential {
  return { type: "api_key", provider, key: AWS_SDK_CREDENTIALS_MARKER };
}

/** Return true when a stored credential is an AWS SDK account marker. */
export function isAwsSdkAuthProfileCredential(credential: AuthProfileCredential): boolean {
  return credential.type === "api_key" && credential.key?.trim() === AWS_SDK_CREDENTIALS_MARKER;
}
