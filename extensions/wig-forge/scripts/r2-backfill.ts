import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { writeJsonAtomic } from "../../../src/infra/json-files.js";
import { resolveWigForgeConfig } from "../src/config.js";
import { WigForgeR2Sync } from "../src/r2.js";
import type { WigForgeAssetFiles, WigForgeInventoryDocument } from "../src/types.js";

async function main(): Promise<void> {
  const storageDir = process.argv[2] || process.env.WIG_FORGE_STORAGE_DIR;
  if (!storageDir) {
    throw new Error(
      "Pass the shared wig-forge storage dir as the first arg, or set WIG_FORGE_STORAGE_DIR.",
    );
  }

  const config = resolveWigForgeConfig({
    r2: {
      accountId: process.env.WIG_FORGE_R2_ACCOUNT_ID,
      bucket: process.env.WIG_FORGE_R2_BUCKET,
      accessKeyId: process.env.WIG_FORGE_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.WIG_FORGE_R2_SECRET_ACCESS_KEY,
      publicBaseUrl: process.env.WIG_FORGE_R2_PUBLIC_BASE_URL,
      keyPrefix: process.env.WIG_FORGE_R2_KEY_PREFIX,
    },
  });

  if (!config.r2) {
    throw new Error(
      "R2 config is incomplete. Set WIG_FORGE_R2_ACCOUNT_ID / BUCKET / ACCESS_KEY_ID / SECRET_ACCESS_KEY.",
    );
  }

  const sync = new WigForgeR2Sync(config.r2);
  const root = path.resolve(storageDir);
  const entries = await fs.readdir(root, { withFileTypes: true });
  let inventoryCount = 0;
  let assetCount = 0;
  let uploadedCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "_market") {
      continue;
    }
    const inventoryPath = path.join(root, entry.name, "inventory.json");
    const doc = await readInventoryIfPresent(inventoryPath);
    if (!doc) {
      continue;
    }
    inventoryCount += 1;
    let inventoryChanged = false;

    for (const asset of doc.assets || []) {
      assetCount += 1;
      const result = await backfillAssetFiles(sync, asset.id, asset.files);
      if (result.changed) {
        asset.files = {
          ...asset.files,
          ...result.files,
        };
        uploadedCount += result.uploadedCount;
        inventoryChanged = true;
      }
    }

    if (inventoryChanged) {
      await writeJsonAtomic(inventoryPath, {
        ...doc,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        storageDir: root,
        inventoriesScanned: inventoryCount,
        assetsScanned: assetCount,
        uploadedObjects: uploadedCount,
      },
      null,
      2,
    ),
  );
}

async function readInventoryIfPresent(filePath: string): Promise<WigForgeInventoryDocument | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as WigForgeInventoryDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function backfillAssetFiles(
  sync: WigForgeR2Sync,
  assetId: string,
  files: WigForgeAssetFiles,
) {
  let uploadedCount = 0;
  let changed = false;
  const next: Partial<WigForgeAssetFiles> = {};

  const uploads = [
    {
      localPath: files.sourcePath,
      currentUrl: files.sourceUrl,
      targetField: "sourceUrl" as const,
      fileName: files.sourcePath ? path.basename(files.sourcePath) : "source.bin",
      contentType: inferContentType(files.sourcePath, files.mimeType) || "application/octet-stream",
    },
    {
      localPath: files.spritePath,
      currentUrl: files.spriteUrl,
      targetField: "spriteUrl" as const,
      fileName: "sprite.png",
      contentType: "image/png",
    },
    {
      localPath: files.previewPath,
      currentUrl: files.previewUrl,
      targetField: "previewUrl" as const,
      fileName: "preview.png",
      contentType: "image/png",
    },
    {
      localPath: files.svgPath,
      currentUrl: files.svgUrl,
      targetField: "svgUrl" as const,
      fileName: "vector.svg",
      contentType: "image/svg+xml; charset=utf-8",
    },
  ];

  for (const upload of uploads) {
    if (!upload.localPath || upload.currentUrl) {
      continue;
    }
    try {
      const body = await fs.readFile(
        upload.localPath,
        upload.targetField === "svgUrl" ? "utf8" : undefined,
      );
      const result = await sync.uploadObject({
        assetId,
        fileName: upload.fileName,
        body,
        contentType: upload.contentType,
      });
      if (result.url) {
        next[upload.targetField] = result.url;
        changed = true;
        uploadedCount += 1;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }

  return {
    changed,
    uploadedCount,
    files: next,
  };
}

function inferContentType(filePath?: string, fallback?: string): string | undefined {
  if (fallback?.trim()) {
    return fallback;
  }
  const extension = path.extname(filePath || "").toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  return undefined;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
