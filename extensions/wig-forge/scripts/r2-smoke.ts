import crypto from "node:crypto";
import process from "node:process";
import { DeleteObjectCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { resolveWigForgeConfig } from "../src/config.js";
import { WigForgeR2Sync } from "../src/r2.js";

async function main(): Promise<void> {
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

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
  });
  const sync = new WigForgeR2Sync(config.r2);

  await client.send(
    new HeadBucketCommand({
      Bucket: config.r2.bucket,
    }),
  );

  const probeAssetId =
    process.env.WIG_FORGE_R2_SMOKE_ASSET_ID ||
    `smoke-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString("hex")}`;
  const fileName = "probe.svg";
  const body = makeProbeSvg(probeAssetId);
  const upload = await sync.uploadObject({
    assetId: probeAssetId,
    fileName,
    body,
    contentType: "image/svg+xml; charset=utf-8",
    cacheControl: "public, max-age=60",
  });

  const publicCheck = upload.url ? await probePublicUrl(upload.url) : null;
  const cleanupEnabled = process.env.WIG_FORGE_R2_SMOKE_KEEP !== "1";
  let cleanedUp = false;

  if (cleanupEnabled) {
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.r2.bucket,
        Key: upload.key,
      }),
    );
    cleanedUp = true;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        bucket: config.r2.bucket,
        accountId: config.r2.accountId,
        endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
        uploaded: {
          assetId: probeAssetId,
          key: upload.key,
          url: upload.url || null,
        },
        publicCheck,
        cleanedUp,
      },
      null,
      2,
    ),
  );
}

function makeProbeSvg(label: string): string {
  const safeLabel = label.replace(/[^a-zA-Z0-9 -]/g, "").slice(0, 32) || "wig-forge";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="0 0 640 640">`,
    `<defs>`,
    `<linearGradient id="g" x1="0%" x2="100%" y1="0%" y2="100%">`,
    `<stop offset="0%" stop-color="#F8F6F0" />`,
    `<stop offset="100%" stop-color="#D7EFE6" />`,
    `</linearGradient>`,
    `</defs>`,
    `<rect width="640" height="640" rx="160" fill="url(#g)" />`,
    `<circle cx="320" cy="248" r="108" fill="#131313" fill-opacity="0.08" />`,
    `<path d="M196 404c40-76 208-76 248 0" stroke="#131313" stroke-width="18" stroke-linecap="round" />`,
    `<text x="50%" y="84%" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#131313">`,
    safeLabel,
    `</text>`,
    `</svg>`,
  ].join("");
}

async function probePublicUrl(url: string) {
  await new Promise((resolve) => setTimeout(resolve, 350));

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
    });
    return {
      url,
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type"),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
