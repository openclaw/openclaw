import fs from "node:fs/promises";

/**
 * Error thrown when a post-write verification fails.
 *
 * This is a distinct error class so that callers — in particular
 * `wrapEditToolWithRecovery` — can detect it and avoid converting a verifier
 * failure into a misleading success result.
 */
export class WriteVerificationError extends Error {
  readonly verifierFailure = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WriteVerificationError";
  }
}

export function isWriteVerificationError(err: unknown): err is WriteVerificationError {
  return (
    err instanceof WriteVerificationError ||
    (err instanceof Error && (err as { verifierFailure?: unknown }).verifierFailure === true)
  );
}

type FileStatLike = { type?: string; size?: number; isFile?: () => boolean };

/**
 * Verify that a file written via the host or sandbox layer actually landed on
 * disk with the expected size. Throws `WriteVerificationError` on any mismatch.
 *
 * Accepts both Node `fs.Stats` (host) and the sandbox bridge stat shape
 * (`{ type, size }`).
 */
export function verifyWrittenStat(params: {
  absolutePath: string;
  content: string;
  stat: FileStatLike | null | undefined;
}): void {
  const { absolutePath, content, stat } = params;
  if (!stat) {
    throw new WriteVerificationError(
      `Write verification failed: file does not exist after write (${absolutePath})`,
    );
  }

  const isFile = typeof stat.isFile === "function" ? stat.isFile() : stat.type === "file";
  if (!isFile) {
    throw new WriteVerificationError(
      `Write verification failed: path is not a file after write (${absolutePath})`,
    );
  }

  const expectedSize = Buffer.byteLength(content, "utf-8");
  if (typeof stat.size === "number" && stat.size !== expectedSize) {
    throw new WriteVerificationError(
      `Write verification failed: expected ${expectedSize} bytes but file has ${stat.size} bytes (${absolutePath})`,
    );
  }
}

/**
 * Stat a host file with a friendly error message for missing files.
 */
export async function verifyHostFile(absolutePath: string, content: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absolutePath);
  } catch (err) {
    throw new WriteVerificationError(
      `Write verification failed: file does not exist after write (${absolutePath})`,
      { cause: err },
    );
  }
  verifyWrittenStat({ absolutePath, content, stat });
}
