/**
 * Private temporary file helper for tool output spillover.
 *
 * Creates owner-only log files without reusing predictable names.
 */
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const filePath = createPrivateTempFilePath(prefix);
  await writeFile(filePath, content, { flag: "wx", mode: 0o600 });
  options?.assertCurrent?.();
  return filePath;
}

function createPrivateTempFilePath(prefix: string): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `${prefix}-${id}.log`);
}
