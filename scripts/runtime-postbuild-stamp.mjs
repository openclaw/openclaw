import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGitHead } from "./build-stamp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAMP_FILE = ".runtime-postbuildstamp";

/**
 * Write `dist/.runtime-postbuildstamp` so that the runner's
 * `resolveRuntimePostBuildRequirement` check (`scripts/run-node.mjs`) does not
 * fall through to a redundant runtime artifact resync after a normal
 * `pnpm build` whose pipeline already invoked `runtime-postbuild`.
 *
 * Stamp shape mirrors what the runner writes after its own resync, so the
 * downstream readers in `run-node.mjs` (mtime, head fields) work unchanged.
 *
 * Best-effort: failures only delay the next CLI startup by one resync cycle,
 * so we log via `warn` and keep going. This matches the existing fall-back
 * behavior in the runner's stamp writer. See #73151.
 */
export function writeRuntimePostBuildStamp(params = {}) {
  const cwd = params.cwd ?? params.rootDir ?? ROOT;
  const fsImpl = params.fs ?? fs;
  const now = params.now ?? Date.now;
  const warn = params.warn ?? console.warn;
  const distRoot = path.join(cwd, "dist");
  const stampPath = path.join(distRoot, STAMP_FILE);
  try {
    fsImpl.mkdirSync(distRoot, { recursive: true });
    const head = resolveGitHead({ cwd, spawnSync: params.spawnSync });
    const stamp = head ? { syncedAt: now(), head } : { syncedAt: now() };
    fsImpl.writeFileSync(stampPath, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
    return stampPath;
  } catch (error) {
    warn(
      `[runtime-postbuild] failed to write stamp ${stampPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}
