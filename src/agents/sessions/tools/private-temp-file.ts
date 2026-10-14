/**
 * Private temporary file helper for tool output spillover.
 *
 * Creates owner-only log files without reusing predictable names.
 */
import { randomBytes, randomUUID } from "node:crypto";
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
    if (stageInput) {
      return stageInput({
        prefix,
        content,
        signal: options.signal,
        assertCurrent: () => options.assertCurrent?.(),
      });
    }
    if (!bridge.createFileExclusive) {
      throw new Error("Sandbox does not support private output staging");
    }
    const { stagedInputDirectory, STAGED_INPUT_GITIGNORE } =
      await import("../../../media/staged-inputs.js");
    const directory = stagedInputDirectory(randomUUID());
    const filePath = `${directory}/${prefix}.log`;
    for (const [target, data] of [
      [`${directory}/.gitignore`, STAGED_INPUT_GITIGNORE],
      [filePath, content],
    ] as const) {
      options.assertCurrent?.();
      const created = await bridge.createFileExclusive({
        filePath: target,
        cwd: root,
        data,
        signal: options.signal,
      });
      if (created !== "created") {
        throw new Error("Private output staging path already exists");
      }
    }
    options.assertCurrent?.();
    return bridge.resolvePath({ filePath, cwd: root }).containerPath;
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
