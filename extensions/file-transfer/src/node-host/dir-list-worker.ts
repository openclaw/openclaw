import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { createCanonicalDirListCommand } from "./dir-list-worker-command.js";

const CANONICAL_PATH_CHANGED_EXIT_CODE = 78;
const DIR_LIST_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

type CanonicalDirListEntry = {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  mtimeMs: number;
};

type CanonicalDirListResult =
  | { ok: true; entries: CanonicalDirListEntry[]; total: number }
  | { ok: false; code: "CANONICAL_PATH_CHANGED" | "READ_ERROR" };

export async function listCanonicalDirectory(
  input: Parameters<typeof createCanonicalDirListCommand>[0],
): Promise<CanonicalDirListResult> {
  // The worker binds cwd before validating it. Relative listing and metadata
  // reads therefore stay on that directory object if its path is replaced.
  const result = await runCommandBuffered(createCanonicalDirListCommand(input), {
    discardOutput: { stderr: true },
    maxOutputBytes: { stdout: DIR_LIST_MAX_OUTPUT_BYTES, stderr: 64 * 1024 },
    timeoutMs: 60_000,
  }).catch(() => null);
  if (result?.termination === "exit" && result.code === CANONICAL_PATH_CHANGED_EXIT_CODE) {
    return { ok: false, code: "CANONICAL_PATH_CHANGED" };
  }
  if (!result || result.termination !== "exit" || result.code !== 0) {
    return { ok: false, code: "READ_ERROR" };
  }
  try {
    // Only our fixed worker writes stdout; filesystem names do not control its shape.
    const listing: { entries: CanonicalDirListEntry[]; total: number } = JSON.parse(
      result.stdout.toString("utf8"),
    );
    return { ok: true, ...listing };
  } catch {
    return { ok: false, code: "READ_ERROR" };
  }
}
