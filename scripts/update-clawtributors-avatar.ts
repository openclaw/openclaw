import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import type { Entry } from "./update-clawtributors.types.js";

const AVATAR_FETCH_TIMEOUT_MS = 8000;
const CLAWTRIBUTORS_USER_AGENT = "openclaw-clawtributors";

export type AvatarAssetEntry = Pick<Entry, "key" | "login" | "display" | "avatar_url">;

export type ResolveRenderableAvatarUrlOptions = {
  avatarSize: number;
  assetDir: string;
  assetPathPrefix: string;
  fetchImpl?: typeof fetch;
};

export function needsLocalAvatarAsset(
  dimensions: { width: number; height: number },
  avatarSize: number,
): boolean {
  return dimensions.width > avatarSize || dimensions.height > avatarSize;
}

export function buildClawtributorAvatarAssetPath(
  entry: AvatarAssetEntry,
  assetPathPrefix: string,
): string {
  return `${assetPathPrefix}/${buildClawtributorAvatarAssetBaseName(entry)}.png`;
}

export async function resolveRenderableAvatarUrl(
  entry: AvatarAssetEntry,
  options: ResolveRenderableAvatarUrlOptions,
): Promise<{ avatarUrl: string; usedLocalAsset: boolean }> {
  if (!/^https?:/i.test(entry.avatar_url)) {
    return { avatarUrl: entry.avatar_url, usedLocalAsset: false };
  }

  const assetRelativePath = buildClawtributorAvatarAssetPath(entry, options.assetPathPrefix);
  const assetAbsolutePath = resolve(
    options.assetDir,
    `${buildClawtributorAvatarAssetBaseName(entry)}.png`,
  );
  const buffer = await fetchAvatarBuffer(entry.avatar_url, options.fetchImpl ?? fetch);

  if (!buffer) {
    if (existsSync(assetAbsolutePath)) {
      return { avatarUrl: assetRelativePath, usedLocalAsset: true };
    }
    return { avatarUrl: entry.avatar_url, usedLocalAsset: false };
  }

  const metadata = await sharp(buffer).metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    !needsLocalAvatarAsset({ width: metadata.width, height: metadata.height }, options.avatarSize)
  ) {
    return { avatarUrl: entry.avatar_url, usedLocalAsset: false };
  }

  const resizedBuffer = await sharp(buffer)
    .resize(options.avatarSize, options.avatarSize, { fit: "cover" })
    .png()
    .toBuffer();

  mkdirSync(options.assetDir, { recursive: true });
  writeFileSync(assetAbsolutePath, resizedBuffer);

  return { avatarUrl: assetRelativePath, usedLocalAsset: true };
}

async function fetchAvatarBuffer(url: string, fetchImpl: typeof fetch): Promise<Buffer | null> {
  try {
    const response = await fetchImpl(url, {
      headers: { "user-agent": CLAWTRIBUTORS_USER_AGENT },
      signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

function buildClawtributorAvatarAssetBaseName(entry: AvatarAssetEntry): string {
  const preferred = slugify(entry.login ?? entry.key);
  if (preferred) {
    return preferred;
  }
  const fallback = slugify(entry.display);
  return fallback || "clawtributor-avatar";
}

function slugify(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
