import { S3Client } from "@aws-sdk/client-s3";
import type { StorageBackend, StorageProviderOpenParams } from "openclaw/plugin-sdk/plugin-entry";
import { createR2Backend } from "./s3-backend.js";
import { parseR2Settings, r2Endpoint } from "./settings.js";

export async function openR2Backend(params: StorageProviderOpenParams): Promise<StorageBackend> {
  const settings = parseR2Settings(params.settings);
  params.signal?.throwIfAborted();
  let credentials;
  try {
    const [accessKeyId, secretAccessKey, sessionToken] = await Promise.all([
      params.resolveSecret(settings.accessKeyId),
      params.resolveSecret(settings.secretAccessKey),
      settings.sessionToken ? params.resolveSecret(settings.sessionToken) : undefined,
    ]);
    if (!accessKeyId || !secretAccessKey || (settings.sessionToken && !sessionToken)) {
      throw new Error("Empty credential");
    }
    credentials = { accessKeyId, secretAccessKey, sessionToken };
  } catch {
    throw new Error(
      "R2 credentials could not be resolved; check the configured SecretRefs and their secret providers.",
    );
  }
  params.signal?.throwIfAborted();
  return createR2Backend(
    settings,
    new S3Client({
      endpoint: r2Endpoint(settings),
      region: "auto",
      credentials,
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    }),
  );
}
