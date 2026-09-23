import fs from "node:fs/promises";
import { readRegularFile } from "../infra/regular-file.js";

const MCP_CLIENT_TLS_FILE_MAX_BYTES = 64 * 1024;

export async function readMcpClientTlsFile(filePath: string): Promise<string> {
  // Resolve configured certificate links before pinning and bounding the regular-file read.
  const { buffer } = await readRegularFile({
    filePath: await fs.realpath(filePath),
    maxBytes: MCP_CLIENT_TLS_FILE_MAX_BYTES,
  });
  return buffer.toString("utf8");
}
