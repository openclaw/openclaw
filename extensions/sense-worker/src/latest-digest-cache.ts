import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../src/config/paths.js";

const LATEST_DIGEST_CACHE_FILE = "nemoclaw-latest-digest.json";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractDigestSummary(payload: unknown): unknown[] | undefined {
  const record = asRecord(payload);
  if (Array.isArray(record?.notification_digest_summary)) {
    return record.notification_digest_summary;
  }
  const result = asRecord(record?.result);
  if (Array.isArray(result?.notification_digest_summary)) {
    return result.notification_digest_summary;
  }
  const completion = asRecord(record?.completion);
  if (Array.isArray(completion?.notification_digest_summary)) {
    return completion.notification_digest_summary;
  }
  return undefined;
}

export function resolveLatestNemoClawDigestCachePath(): string {
  return path.join(resolveStateDir(process.env), "cache", LATEST_DIGEST_CACHE_FILE);
}

export async function writeLatestNemoClawDigestCache(params: {
  payload: unknown;
  event: string;
  jobId?: string;
}): Promise<{ wrote: boolean; path: string }> {
  const digestSummary = extractDigestSummary(params.payload);
  const cachePath = resolveLatestNemoClawDigestCachePath();
  if (!digestSummary || digestSummary.length === 0) {
    return { wrote: false, path: cachePath };
  }
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(
    cachePath,
    JSON.stringify(
      {
        event: params.event,
        jobId: params.jobId?.trim() || null,
        notification_digest_summary: digestSummary,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  return { wrote: true, path: cachePath };
}

export async function readLatestNemoClawDigestCache(): Promise<{
  event?: string;
  jobId?: string | null;
  notification_digest_summary?: unknown[];
  updatedAt?: string;
} | null> {
  const cachePath = resolveLatestNemoClawDigestCachePath();
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      event: typeof parsed.event === "string" ? parsed.event : undefined,
      jobId:
        typeof parsed.jobId === "string" ? parsed.jobId : parsed.jobId === null ? null : undefined,
      notification_digest_summary: Array.isArray(parsed.notification_digest_summary)
        ? parsed.notification_digest_summary
        : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    };
  } catch {
    return null;
  }
}

export const __testing = {
  extractDigestSummary,
};
