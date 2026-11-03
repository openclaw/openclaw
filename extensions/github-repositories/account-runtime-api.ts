import {
  getGatewayServiceLifetime,
  type GatewayRequestContext,
} from "openclaw/plugin-sdk/gateway-runtime";
import { installNativeGitHubLegacyOAuthLookup } from "openclaw/plugin-sdk/native-github-account-host";
import type { NativeGitHubPublicationApi as RepositoryPublicationApi } from "openclaw/plugin-sdk/native-github-publication-host";
import { captureNativeGitHubServiceHost as captureRepositoryServiceHost } from "openclaw/plugin-sdk/native-github-publication-host";
import type { createGitHubOAuthLifecycle } from "./oauth-lifecycle-api.js";

export type RepositoryServices = {
  oauth: ReturnType<typeof createGitHubOAuthLifecycle>;
  publication?: RepositoryPublicationApi;
};
type OwnedServices = { services: RepositoryServices; signal: AbortSignal };
const services = new WeakMap<AbortSignal, OwnedServices>();

/** The service lifetime owns the implementation; RPC contexts only locate its host identity. */
export function installRepositoryServices(
  owner: AbortSignal,
  value: RepositoryServices,
  signal: AbortSignal,
): () => void {
  signal.throwIfAborted();
  if (services.has(owner)) {
    throw new Error("GitHub repository services are already installed for this Gateway.");
  }
  const record = { services: value, signal };
  services.set(owner, record);
  return () => {
    if (services.get(owner) === record) {
      services.delete(owner);
    }
  };
}
export function readRepositoryServices(
  context: GatewayRequestContext,
): RepositoryServices | undefined {
  return readOwnedServices(getGatewayServiceLifetime(context));
}
function readOwnedServices(owner: AbortSignal): RepositoryServices | undefined {
  const record = services.get(owner);
  if (!record || record.signal.aborted) {
    return undefined;
  }
  return record.services;
}
function currentServices() {
  const host = captureRepositoryServiceHost();
  return host ? readOwnedServices(host.identity) : undefined;
}
export async function requestCurrentGitHubOAuthRefresh(agentId: string): Promise<void> {
  await currentServices()?.oauth.refreshEffectiveIdentity(agentId);
}
export async function requestCurrentPersonalGitHubRefresh(owner: string): Promise<void> {
  const current = currentServices();
  if (!current) {
    throw new Error("My GitHub lifecycle is unavailable; retry after Gateway startup.");
  }
  await current.oauth.personal.refresh(owner);
}

/** The compatibility reader captures this exact canonical record, never its replacement. */
export async function installLegacyRepositoryOAuthLookup(owner: AbortSignal): Promise<() => void> {
  const record = services.get(owner);
  if (!record || record.signal.aborted) {
    throw new Error("GitHub repository services are unavailable for legacy lookup.");
  }
  return await installNativeGitHubLegacyOAuthLookup(
    () =>
      services.get(owner) === record && !record.signal.aborted ? record.services.oauth : undefined,
    record.signal,
  );
}
