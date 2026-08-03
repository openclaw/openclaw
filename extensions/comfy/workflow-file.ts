// Comfy workflow file helpers bound local workflowPath reads.
import fs from "node:fs/promises";

const COMFY_WORKFLOW_FILE_READ_CHUNK_BYTES = 64 * 1024;

export async function readComfyWorkflowFile(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Comfy workflow at ${filePath} must be a file`);
    }
    if (stat.size > maxBytes) {
      throw workflowFileTooLargeError(filePath, maxBytes);
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remainingBytes = maxBytes + 1 - totalBytes;
      const scratch = Buffer.allocUnsafe(
        Math.min(COMFY_WORKFLOW_FILE_READ_CHUNK_BYTES, remainingBytes),
      );
      const { bytesRead } = await handle.read(scratch, 0, scratch.length, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes).toString("utf8");
      }
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        throw workflowFileTooLargeError(filePath, maxBytes);
      }
      chunks.push(scratch.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

function workflowFileTooLargeError(filePath: string, maxBytes: number): Error {
  return new Error(
    `Comfy workflow at ${filePath} exceeds ${maxBytes} bytes; raise plugins.entries.comfy.config.workflowFileMaxBytes only when the downstream Comfy service accepts the larger serialized prompt request`,
  );
}
