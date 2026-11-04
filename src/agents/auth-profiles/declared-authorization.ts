import { createHash } from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  AuthProfileAuthorizationError,
  type AuthProfileAuthorization,
} from "./authorization-contract.js";
import { isConfiguredAwsSdkAuthProfileForProvider } from "./order.js";

/**
 * Authorize an account that config declares instead of storing.
 *
 * An `aws-sdk` auth profile holds no credential material: the provider resolves
 * every request through the AWS SDK default chain, so there is no stored row to
 * observe for replacement, refresh, or revocation. The declaration is the
 * account, so the authorization identifies that declaration and a capture fails
 * closed once config stops declaring it — which is what a recorded automation
 * binding compares against on every run.
 */
export function captureDeclaredAuthProfileAuthorization(params: {
  profileId: string;
  provider: string;
  cfg?: OpenClawConfig;
  assertCurrent: () => void;
}): AuthProfileAuthorization {
  let disposed = false;
  let retired = false;
  const assertDeclared = () => {
    if (disposed || retired) {
      throw new AuthProfileAuthorizationError("retired");
    }
    try {
      params.assertCurrent();
    } catch {
      retired = true;
      throw new AuthProfileAuthorizationError("retired");
    }
  };
  assertDeclared();
  if (
    !isConfiguredAwsSdkAuthProfileForProvider({
      cfg: params.cfg,
      provider: params.provider,
      profileId: params.profileId,
    })
  ) {
    throw new AuthProfileAuthorizationError("retired");
  }
  // Hash the declared route, never credential material; the chain resolves that per request.
  const authorizationId = createHash("sha256")
    .update(
      JSON.stringify([
        "declared-auth-profile-v1",
        params.profileId,
        normalizeProviderId(params.provider),
        "aws-sdk",
      ]),
    )
    .digest("hex");
  return {
    authorizationId,
    assertCurrent: assertDeclared,
    async revalidate() {
      assertDeclared();
    },
    dispose() {
      disposed = true;
    },
  };
}
