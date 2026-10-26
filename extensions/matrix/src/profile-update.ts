import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { updateMatrixOwnProfile } from "./matrix/actions/profile.js";
import { updateMatrixAccountConfig, resolveMatrixConfigPath } from "./matrix/config-update.js";
import { getMatrixRuntime } from "./runtime.js";
import type { CoreConfig } from "./types.js";

export async function applyMatrixProfileUpdate(params: {
  cfg?: CoreConfig;
  account?: string;
  displayName?: string;
  avatarUrl?: string;
  avatarPath?: string;
  mediaLocalRoots?: readonly string[];
}) {
  const runtime = getMatrixRuntime();
  const persistedCfg = runtime.config.current() as CoreConfig;
  const accountId = normalizeAccountId(params.account);
  const displayName = params.displayName?.trim() || null;
  const avatarUrl = params.avatarUrl?.trim() || null;
  const avatarPath = params.avatarPath?.trim() || null;
  if (!displayName && !avatarUrl && !avatarPath) {
    throw new Error("Provide name/displayName and/or avatarUrl/avatarPath.");
  }

  const synced = await updateMatrixOwnProfile({
    cfg: params.cfg ?? persistedCfg,
    accountId,
    displayName: displayName ?? undefined,
    avatarUrl: avatarUrl ?? undefined,
    avatarPath: avatarPath ?? undefined,
    mediaLocalRoots: params.mediaLocalRoots,
  });
  const persistedAvatarUrl =
    synced.uploadedAvatarSource && synced.resolvedAvatarUrl ? synced.resolvedAvatarUrl : avatarUrl;
  const updated = updateMatrixAccountConfig(persistedCfg, accountId, {
    name: displayName ?? undefined,
    avatarUrl: persistedAvatarUrl ?? undefined,
  });
  await runtime.config.replaceConfigFile({
    nextConfig: updated as never,
    afterWrite: { mode: "auto" },
  });

  return {
    accountId,
    displayName,
    avatarUrl: persistedAvatarUrl ?? null,
    profile: synced,
    configPath: resolveMatrixConfigPath(updated, accountId),
  };
}
