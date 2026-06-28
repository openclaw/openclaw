export class WriteVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteVerificationError";
  }
}

export function isWriteVerificationError(error: unknown): error is WriteVerificationError {
  return error instanceof WriteVerificationError;
}

type WrittenStat = {
  type: "file" | "directory" | "other";
  size: number;
};

export function verifyWrittenStat(params: {
  absolutePath: string;
  content: string;
  stat: WrittenStat | null;
}): void {
  if (!params.stat) {
    throw new WriteVerificationError(
      `Write verification failed: file does not exist after write (${params.absolutePath})`,
    );
  }
  if (params.stat.type !== "file") {
    throw new WriteVerificationError(
      `Write verification failed: path is not a file after write (${params.absolutePath})`,
    );
  }
  const expectedSize = Buffer.byteLength(params.content, "utf8");
  if (params.stat.size !== expectedSize) {
    throw new WriteVerificationError(
      `Write verification failed: expected ${expectedSize} bytes but file has ${params.stat.size} bytes (${params.absolutePath})`,
    );
  }
}

export function verifyWrittenContent(params: {
  absolutePath: string;
  content: string;
  readback: Buffer | string | undefined;
}): void {
  const currentContent = Buffer.isBuffer(params.readback)
    ? params.readback.toString("utf8")
    : params.readback;
  if (currentContent !== params.content) {
    throw new WriteVerificationError(
      `Write verification failed: readback did not match requested content (${params.absolutePath})`,
    );
  }
}
