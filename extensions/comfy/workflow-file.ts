// Comfy workflow file helpers preserve the direct UTF-8 read for unconfigured
// workflowPath files and bound local reads when the operator configures an
// explicit workflowFileMaxBytes limit.
import fs from "node:fs/promises";

const COMFY_WORKFLOW_FILE_READ_CHUNK_BYTES = 64 * 1024;

export async function readComfyWorkflowFile(
  filePath: string,
  maxBytes: number | undefined,
): Promise<string> {
  if (maxBytes === undefined) {
    return fs.readFile(filePath, "utf8");
  }
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error(`Comfy workflow at ${filePath} must be a file`);
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const scratch = Buffer.allocUnsafe(
        Math.min(COMFY_WORKFLOW_FILE_READ_CHUNK_BYTES, maxBytes + 1 - totalBytes),
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
