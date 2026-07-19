import fs from "node:fs/promises";

const READ_CHUNK_BYTES = 64 * 1024;

// Leave room below the Gateway frame limit for JSON escaping and RPC metadata.
export const MAX_A2UI_JSONL_FILE_BYTES = 8 * 1024 * 1024;

/** Reads an A2UI JSONL file without buffering more than the transport can accept. */
export async function readA2UIJsonlFile(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`A2UI JSONL path is not a file: ${filePath}`);
    }
    if (stat.size > MAX_A2UI_JSONL_FILE_BYTES) {
      throw new RangeError(
        `A2UI JSONL file exceeds ${MAX_A2UI_JSONL_FILE_BYTES} bytes: ${filePath}`,
      );
    }

    const chunks: Buffer[] = [];
    const scratch = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(scratch, 0, scratch.length, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, total).toString("utf8");
      }
      total += bytesRead;
      if (total > MAX_A2UI_JSONL_FILE_BYTES) {
        throw new RangeError(
          `A2UI JSONL file exceeds ${MAX_A2UI_JSONL_FILE_BYTES} bytes: ${filePath}`,
        );
      }
      chunks.push(Buffer.from(scratch.subarray(0, bytesRead)));
    }
  } finally {
    await handle.close();
  }
}
