import type { ResolvedXAccount } from "./accounts.js";
import {
  openXAllowlist,
  type XGitHubEntry,
  type XGitHubSnapshot,
  type XGitHubStatus,
} from "./allowlist.js";
import type { XApiClient } from "./api.js";
import type { createXGitHubReader } from "./github.js";

type Runtime = Parameters<typeof openXAllowlist>[0];

export function emptyXGitHubSnapshot(account: ResolvedXAccount): XGitHubSnapshot {
  return {
    repo: account.config.verifiedFromGitHub!.repo!,
    minPermission: account.config.verifiedFromGitHub?.minPermission ?? "push",
    entries: [],
    unresolvedHandles: [],
    lookupResults: {},
    stale: true,
  };
}

export async function getXGitHubStatus(
  runtime: Runtime,
  account: ResolvedXAccount,
): Promise<XGitHubStatus | undefined> {
  if (!account.config.verifiedFromGitHub?.repo) {
    return undefined;
  }
  const snapshot =
    (await openXAllowlist(runtime).readGitHub(
      account.accountId,
      account.config.verifiedFromGitHub,
    )) ?? emptyXGitHubSnapshot(account);
  const { minPermission: _permission, lookupResults: _lookups, ...status } = snapshot;
  return status;
}

// One completed snapshot replaces the derived set atomically under the allowlist's fence.
export async function syncXGitHub(params: {
  runtime: Runtime;
  account: ResolvedXAccount;
  github: ReturnType<typeof createXGitHubReader>;
  getApi: () => Promise<Pick<XApiClient, "getUsersByUsernames">>;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<XGitHubSnapshot> {
  const { account, assertCurrent, signal } = params;
  const allowlist = openXAllowlist(params.runtime);
  const previous = await allowlist.readGitHub(account.accountId, account.config.verifiedFromGitHub);
  const snapshot = emptyXGitHubSnapshot(account);
  const collaborators = await params.github.readCollaborators(
    snapshot.repo,
    snapshot.minPermission,
    signal,
  );
  assertCurrent();
  const handles = new Set(collaborators.flatMap((entry) => entry.xHandles));
  const resolved = new Map(
    Object.entries(previous?.lookupResults ?? {}).filter(([handle]) => handles.has(handle)),
  );
  const pending = [...handles].filter((handle) => !resolved.has(handle));
  if (pending.length) {
    const api = await params.getApi();
    for (let offset = 0; offset < pending.length; offset += 100) {
      assertCurrent();
      const batch = pending.slice(offset, offset + 100);
      const users = await api.getUsersByUsernames(batch, signal, assertCurrent);
      assertCurrent();
      for (const handle of batch) {
        resolved.set(handle, null);
      }
      for (const user of users) {
        const handle = user.username.toLowerCase();
        if (batch.includes(handle)) {
          resolved.set(handle, user.id);
        }
      }
      // Preserve paid results even if a later batch fails, without admitting a partial set.
      await allowlist.replaceGitHub(
        account.accountId,
        {
          ...(previous ?? snapshot),
          lookupResults: Object.fromEntries(resolved),
        },
        assertCurrent,
      );
    }
  }
  const syncedAt = Date.now();
  const entries: XGitHubEntry[] = collaborators.flatMap((collaborator) =>
    collaborator.xHandles.flatMap((xHandle) => {
      const xUserId = resolved.get(xHandle);
      return xUserId
        ? [
            {
              xUserId,
              xHandle,
              githubLogin: collaborator.githubLogin,
              permission: collaborator.permission,
              syncedAt,
            },
          ]
        : [];
    }),
  );
  const next: XGitHubSnapshot = {
    ...snapshot,
    entries,
    unresolvedHandles: [...handles].filter((handle) => !resolved.get(handle)).toSorted(),
    lookupResults: Object.fromEntries(resolved),
    lastSyncAt: syncedAt,
    stale: false,
  };
  assertCurrent();
  await allowlist.replaceGitHub(account.accountId, next, assertCurrent);
  return next;
}
