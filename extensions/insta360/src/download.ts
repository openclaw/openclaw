import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type DownloadResult = {
  bytesWritten: number;
  destPath: string;
};

export async function downloadFile(
  url: string,
  destPath: string,
  opts?: { timeoutMs?: number },
): Promise<DownloadResult> {
  const timeoutMs = opts?.timeoutMs ?? 10 * 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: ${response.status} for ${url}`);
    }

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const dest = createWriteStream(destPath);
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      dest,
    );

    return { bytesWritten: dest.bytesWritten, destPath };
  } finally {
    clearTimeout(timer);
  }
}
