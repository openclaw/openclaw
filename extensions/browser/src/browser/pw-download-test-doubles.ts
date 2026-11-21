import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { vi } from "vitest";

const openDownloadFile = fs.open.bind(fs);

/** Bytes a Playwright download double exposes through createReadStream. */
export function downloadReadStream(
  contents: string | Buffer,
  options?: {
    beforeYield?: () => Promise<void> | void;
    afterYield?: () => Promise<void> | void;
  },
) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  return vi.fn(async () =>
    Readable.from(
      (async function* () {
        await options?.beforeYield?.();
        yield bytes;
        await options?.afterYield?.();
      })(),
    ),
  );
}

/** Paths opened for sibling staging files while a download is written. */
export function trackDownloadStagingOpens(): string[] {
  const opened: string[] = [];
  vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    if (flags === "w" && String(file).endsWith(".part")) {
      opened.push(String(file));
    }
    return await openDownloadFile(file, flags, mode);
  });
  return opened;
}
