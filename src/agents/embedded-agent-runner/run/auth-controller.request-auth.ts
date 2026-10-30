import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { Model } from "../../../llm/types.js";
import { assertProviderAuthAuthority } from "../../../plugins/provider-auth-authority.js";
import type { ProviderCreateStreamFnContext } from "../../../plugins/provider-transport.types.js";
import { hasOAuthIdentity, isSafeToCopyOAuthIdentity } from "../../auth-profiles/oauth-identity.js";
import type { OAuthCredential } from "../../auth-profiles/types.js";
import { getApiKeyForModelCore, type ResolvedProviderAuth } from "../../model-auth.js";
import { unwrapSecretSentinelsForProviderEgress } from "../../provider-secret-egress.js";

/** The controller retains selection/account lifetime; native OAuth owners retain refresh settlement. */
export function createEmbeddedRequestAuth(params: {
  model: Model;
  selected: OAuthCredential;
  profileId: string;
  config: OpenClawConfig | undefined;
  agentDir: string;
  workspaceDir: string;
  signal?: AbortSignal;
  assertAdmission: () => void;
  assertCurrent: () => void;
  prepare(apiKey: string): Promise<{ apiKey?: string } | undefined>;
  install(current: ResolvedProviderAuth, apiKey: string): void;
}): NonNullable<ProviderCreateStreamFnContext["requestAuth"]> {
  return {
    version: 1,
    async resolve({ signal }) {
      const requestSignal =
        params.signal && signal
          ? AbortSignal.any([params.signal, signal])
          : (signal ?? params.signal);
      const assertAdmission = () => {
        requestSignal?.throwIfAborted();
        params.assertAdmission();
      };
      const assertCurrent = () => {
        assertAdmission();
        params.assertCurrent();
      };
      assertCurrent();
      // Omit the attempt's captured store. Canonical resolution owns refresh/rotation.
      const current = await getApiKeyForModelCore({
        model: params.model,
        cfg: params.config,
        profileId: params.profileId,
        lockedProfile: true,
        allowAuthProfileFallback: false,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        signal: requestSignal,
        assertRefreshAdmission: assertCurrent,
        validateOAuthCredential: (credential) => {
          if (
            credential.provider !== params.selected.provider ||
            credential.authFlow !== params.selected.authFlow ||
            !isSafeToCopyOAuthIdentity(params.selected, credential) ||
            (!hasOAuthIdentity(params.selected) && credential.refresh !== params.selected.refresh)
          ) {
            throw new Error("Provider request credentials changed account identity.");
          }
        },
      });
      assertCurrent();
      if (current.profileId !== params.profileId || current.mode !== "oauth" || !current.apiKey) {
        throw new Error("Provider request credentials no longer match the selected OAuth profile.");
      }
      const prepared = await params.prepare(current.apiKey);
      const assertRequestCurrent = () => {
        assertCurrent();
        assertProviderAuthAuthority(current);
      };
      assertRequestCurrent();
      const apiKey = prepared?.apiKey ?? current.apiKey;
      params.install(current, apiKey);
      return {
        apiKey: unwrapSecretSentinelsForProviderEgress(apiKey, "provider request auth"),
        assertCurrent: assertRequestCurrent,
      };
    },
  };
}
