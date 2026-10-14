/**
 * Private temporary file helper for tool output spillover.
 *
 * Creates owner-only log files without reusing predictable names.
 */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function writePrivateTempFile(prefix: string, content: string): Promise<string> {
  const filePath = createPrivateTempFilePath(prefix);
  await writeFile(filePath, content, { flag: "wx", mode: 0o600 });
  return filePath;
}

function createPrivateTempFilePath(prefix: string): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `${prefix}-${id}.log`);
}
