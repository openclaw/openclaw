/**
 * Private temporary file helper for tool output spillover.
 *
 * Creates owner-only log files without reusing predictable names.
 */
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { finished } from "node:stream/promises";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.types.js";
import { getSandboxInputStager } from "../../sandbox/input-staging.js";

export type PrivateTempFileOptions = {
  sandbox?: { root?: string; bridge?: SandboxFsBridge };
  assertCurrent?: () => void;
  signal?: AbortSignal;
};

export async function writePrivateTempFile(
  prefix: string,
  content: string,
  options?: PrivateTempFileOptions,
): Promise<string> {
  options?.assertCurrent?.();
  if (options?.sandbox) {
    const { root, bridge } = options.sandbox;
    if (!root || !bridge) {
      throw new Error("Sandbox output context is unavailable");
    }
    const stageInput = getSandboxInputStager(bridge);
    if (!stageInput) {
      throw new Error("Sandbox does not support private output staging");
    }
    return stageInput({
      prefix,
      content,
      signal: options.signal,
      assertCurrent: () => options.assertCurrent?.(),
    });
  }
  const { capturePathRemovalGuard, removePathWithinRoot } =
    await import("../../../infra/fs-safe-remove.js");
  const filePath = createPrivateTempFilePath(prefix);
  const assertRoot = capturePathRemovalGuard(tmpdir());
  if (!assertRoot) {
    throw new Error("Private output directory is unavailable");
  }
  // An unsuccessful exclusive open never grants custody of an existing path.
  const file = await open(filePath, "wx", 0o600);
  let assertFile: (() => void) | undefined;
  const cleanup = async () => {
    if (!assertFile) {
      return;
    }
    await removePathWithinRoot({
      rootDir: tmpdir(),
      relativePath: basename(filePath),
      assertBeforeMutation: () => {
        assertRoot();
        assertFile?.();
      },
    });
  };
  try {
    assertFile = capturePathRemovalGuard(filePath);
    if (!assertFile) {
      throw new Error("Private output disappeared during creation");
    }
    await file.writeFile(content);
    await file.close();
  } catch (error) {
    // Preserve the operation's error even if best-effort removal also fails.
    await file.close().catch(() => undefined);
    await cleanup().catch(() => undefined);
    throw error;
  }
  options?.assertCurrent?.();
  return filePath;
}

/** Streamed private temp file: the same location and retention as writePrivateTempFile. */
export type PrivateTempFileStream = {
  readonly path: string;
  /** Bytes written; never more than the stream's maxBytes. */
  readonly bytes: number;
  /** Later writes were discarded at maxBytes. */
  readonly limitReached: boolean;
  write: (text: string) => void;
  /** Resolves true when every accepted byte is on disk. */
  close: () => Promise<boolean>;
  remove: () => Promise<void>;
};

/** Host-only: opens one owner-only temp file for ordered appends up to maxBytes. */
export function openPrivateTempFileStream(prefix: string, maxBytes: number): PrivateTempFileStream {
  const path = createPrivateTempFilePath(prefix);
  // An exclusive open never grants custody of an existing path.
  const stream = createWriteStream(path, { flags: "wx", mode: 0o600 });
  const done = finished(stream).then(
    () => true,
    () => false,
  );
  let bytes = 0;
  let limitReached = false;
  return {
    path,
    get bytes() {
      return bytes;
    },
    get limitReached() {
      return limitReached;
    },
    write(text) {
      if (limitReached || stream.writableEnded || stream.destroyed) {
        return;
      }
      let data = Buffer.from(text);
      if (bytes + data.length > maxBytes) {
        data = data.subarray(0, maxBytes - bytes);
        limitReached = true;
      }
      bytes += data.length;
      stream.write(data);
    },
    close() {
      stream.end();
      return done;
    },
    async remove() {
      stream.end();
      await done;
      await unlink(path).catch(() => undefined);
    },
  };
}

function createPrivateTempFilePath(prefix: string): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `${prefix}-${id}.log`);
}
