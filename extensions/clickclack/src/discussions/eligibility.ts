import type { SessionDiscussionInfo } from "openclaw/plugin-sdk/session-discussion";
import {
  listEnabledClickClackAccounts,
  listClickClackAccountIds,
  resolveClickClackAccountMetadata,
  resolveClickClackAccountAsync,
} from "../accounts.js";
import type { CoreConfig, ResolvedClickClackAccount } from "../types.js";
import type { ClickClackDiscussionBinding } from "./binding-store.js";
import { discussionCredentialFingerprint } from "./naming.js";

export function discussionAccounts(cfg: CoreConfig): ResolvedClickClackAccount[] {
  return listClickClackAccountIds(cfg)
    .map((accountId) => resolveClickClackAccountMetadata({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured && account.discussions.enabled);
}

export function normalizedServerBaseUrl(account: ResolvedClickClackAccount): string {
  return account.baseUrl.replace(/\/+$/u, "");
}

export type DiscussionBindingAccountResolution =
  | { state: "active"; account: ResolvedClickClackAccount }
  | { state: "unavailable" }
  | { state: "stale"; account: ResolvedClickClackAccount };

/** Resolves the sole live account and rejects bindings pinned to an older destination. */
export function resolveDiscussionBindingAccount(
  cfg: CoreConfig,
  binding: ClickClackDiscussionBinding,
): DiscussionBindingAccountResolution {
  // Explicit public synchronous visibility callers retain their documented live-read contract.
  const accounts = listEnabledClickClackAccounts(cfg).filter(
    (account) => account.configured && account.discussions.enabled,
  );
  return resolveBindingAccount(accounts.length === 1 ? accounts[0] : undefined, binding);
}

function resolveBindingAccount(
  account: ResolvedClickClackAccount | undefined,
  binding: ClickClackDiscussionBinding,
): DiscussionBindingAccountResolution {
  if (!account) {
    return { state: "unavailable" };
  }
  if (
    account.accountId !== binding.accountId ||
    normalizedServerBaseUrl(account) !== binding.serverBaseUrl ||
    account.discussions.workspace !== binding.workspaceRef ||
    (binding.credentialFingerprint !== undefined &&
      discussionCredentialFingerprint(account.token) !== binding.credentialFingerprint)
  ) {
    return { state: "stale", account };
  }
  return { state: "active", account };
}

/** Config and binding checks stay synchronous after credential preparation. */
export function isDiscussionAccountCurrent(
  cfg: CoreConfig,
  account: ResolvedClickClackAccount,
): boolean {
  const accounts = discussionAccounts(cfg);
  const current = accounts.length === 1 ? accounts[0] : undefined;
  return (
    current !== undefined &&
    current.accountId === account.accountId &&
    current.baseUrl === account.baseUrl &&
    current.apiEndpoint === account.apiEndpoint &&
    current.discussions.workspace === account.discussions.workspace &&
    current.config.tokenFile?.trim() === account.config.tokenFile?.trim() &&
    (current.tokenSource === "tokenFile" || current.token === account.token)
  );
}

export function resolvePreparedDiscussionBindingAccount(
  cfg: CoreConfig,
  binding: ClickClackDiscussionBinding,
  account: ResolvedClickClackAccount,
): DiscussionBindingAccountResolution {
  return isDiscussionAccountCurrent(cfg, account)
    ? resolveBindingAccount(account, binding)
    : { state: "unavailable" };
}

export async function prepareDiscussionBindingAccount(
  cfg: CoreConfig,
  binding: ClickClackDiscussionBinding,
): Promise<DiscussionBindingAccountResolution> {
  const accounts = discussionAccounts(cfg);
  if (accounts.length !== 1) {
    return { state: "unavailable" };
  }
  const account = await resolveClickClackAccountAsync({ cfg, accountId: accounts[0]!.accountId });
  return resolveBindingAccount(account, binding);
}

/** Public embed/open URLs for one bound discussion channel. */
export function discussionInfoForBinding(
  binding: ClickClackDiscussionBinding,
  account: ResolvedClickClackAccount,
): SessionDiscussionInfo {
  const baseUrl = normalizedServerBaseUrl(account);
  return {
    state: "open",
    // Only this provider may opt into host-owned theme parameters; signed
    // discussion URLs from other providers must remain opaque.
    embedUrl: `${baseUrl}/embed/channel/${encodeURIComponent(binding.workspaceRouteId)}/${encodeURIComponent(binding.channelRouteId)}?openclawHostTheme=1`,
    openUrl: `${baseUrl}/app/${encodeURIComponent(binding.workspaceRouteId)}/${encodeURIComponent(binding.channelRouteId)}`,
  };
}
