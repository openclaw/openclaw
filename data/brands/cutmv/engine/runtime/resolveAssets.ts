/**
 * resolveAssets.ts — Brand-safe asset resolver.
 *
 * Every asset referenced in a MotionSpec must:
 *   1. Belong to the declared brand (no cross-brand contamination)
 *   2. Exist on disk (pre-render validation)
 *   3. Use staticFile() paths that are relative to public/
 *
 * Usage:
 *   import { resolveAsset, validateAssetExists } from './resolveAssets';
 */

import * as fs from "fs";
import * as path from "path";

type Brand = "cutmv" | "fulldigital";

interface AssetRef {
  path: string;
  brand: Brand;
  loader?: "staticFile" | "import";
}

interface ResolvedAsset {
  staticPath: string; // path for staticFile()
  absolutePath: string; // full disk path
  exists: boolean;
  brand: Brand;
}

// ── Asset resolver ──
export function resolveAsset(
  asset: AssetRef,
  expectedBrand: Brand,
  publicDir: string,
): ResolvedAsset {
  // Brand mismatch check
  if (asset.brand !== expectedBrand) {
    throw new Error(
      `ASSET BRAND MISMATCH: expected "${expectedBrand}", got "${asset.brand}" for asset "${asset.path}"`,
    );
  }

  // Path prefix check — asset.path should start with the brand name
  if (!asset.path.startsWith(`${expectedBrand}/`)) {
    throw new Error(
      `ASSET PATH VIOLATION: "${asset.path}" does not start with "${expectedBrand}/". Cross-brand assets are blocked.`,
    );
  }

  const absolutePath = path.resolve(publicDir, asset.path);
  const exists = fs.existsSync(absolutePath);

  return {
    staticPath: asset.path,
    absolutePath,
    exists,
    brand: asset.brand,
  };
}

// ── Batch validator ──
export function validateAllAssets(
  assets: AssetRef[],
  expectedBrand: Brand,
  publicDir: string,
): { valid: boolean; resolved: ResolvedAsset[]; missing: string[] } {
  const resolved: ResolvedAsset[] = [];
  const missing: string[] = [];

  for (const asset of assets) {
    try {
      const r = resolveAsset(asset, expectedBrand, publicDir);
      resolved.push(r);
      if (!r.exists) {
        missing.push(r.absolutePath);
      }
    } catch (err) {
      // Brand mismatch is an immediate failure
      throw err;
    }
  }

  return {
    valid: missing.length === 0,
    resolved,
    missing,
  };
}

// ── Extract all asset refs from a MotionSpec ──
export function extractAssetsFromSpec(
  spec: Record<string, unknown>,
): AssetRef[] {
  const brand = (spec.brand as Brand) || "cutmv";
  const assets: AssetRef[] = [];

  // Check top-level assets
  const topAssets = spec.assets as Record<string, unknown> | undefined;
  if (topAssets) {
    for (const [, val] of Object.entries(topAssets)) {
      if (typeof val === "object" && val !== null) {
        const a = val as Record<string, unknown>;
        if (typeof a.path === "string") {
          assets.push({
            path: a.path,
            brand,
            loader: (a.loader as "staticFile" | "import") || "staticFile",
          });
        }
      }
    }
  }

  // Check structure scenes
  const structure = spec.structure as Record<string, unknown>[] | undefined;
  if (structure) {
    for (const scene of structure) {
      // scene.asset
      const asset = scene.asset as Record<string, unknown> | undefined;
      if (asset && typeof asset.path === "string") {
        assets.push({
          path: asset.path,
          brand,
          loader: (asset.loader as "staticFile" | "import") || "staticFile",
        });
      }

      // scene.logo
      const logo = scene.logo as Record<string, unknown> | undefined;
      if (logo && typeof logo.path === "string") {
        assets.push({
          path: logo.path,
          brand,
          loader: (logo.loader as "staticFile" | "import") || "staticFile",
        });
      }
    }
  }

  return assets;
}
