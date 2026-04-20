/**
 * PR-14: persist a rendered plan archetype as a markdown file under
 * `~/.openclaw/agents/<agentId>/plans/`. The file is the canonical
 * artifact for any future channel-attachment delivery (Telegram today;
 * Discord/Slack/etc. later by mirroring the bridge pattern).
 *
 * Always written, regardless of session origin (web/CLI/Telegram/etc.)
 * — operators get a durable audit trail of every `exit_plan_mode`
 * cycle. Telegram/channel delivery is layered on top by
 * `plan-archetype-bridge.ts`.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildPlanFilename } from "./plan-archetype-prompt.js";

export interface PersistPlanArchetypeMarkdownInput {
  agentId: string;
  /**
   * Used to compute the filename slug. Falls back to the literal
   * \`"untitled"\` slug inside \`buildPlanFilenameSlug\` (see
   * \`plan-archetype-prompt.ts:142-155\`) when the title is empty
   * after sanitization. Operators looking for a persisted plan with
   * no title should grep for \`plan-YYYY-MM-DD-untitled.md\`.
   *
   * Copilot review #68939 (2026-04-19): doc previously said the
   * fallback was \`"plan"\` — that was wrong; the helper has always
   * returned \`"untitled"\`.
   */
  title: string | undefined;
  markdown: string;
  /** Wall-clock now. Defaults to new Date(); injectable for tests. */
  now?: Date;
  /**
   * Override the base directory (defaults to `os.homedir()/.openclaw/agents`).
   * Tests use this to redirect to a temp dir; production never sets it.
   * The agentId is appended under this base.
   */
  baseDir?: string;
  /**
   * R4 test-only hook: override the writeFile function used for the
   * final markdown write. Lets tests inject ENOSPC/EACCES/EIO without
   * having to mock the ESM module namespace. Production never sets it;
   * omit → uses `fsp.writeFile` directly.
   */
  _writeFileForTest?: (
    path: string,
    data: string,
    options: { encoding: "utf8"; flag: "wx" },
  ) => Promise<void>;
}

export interface PersistPlanArchetypeMarkdownResult {
  absPath: string;
  filename: string;
}

/**
 * Maximum collision-suffix tries before giving up. With per-day
 * filenames this is effectively unreachable in production (would
 * require >99 plan cycles for the same title on a single day for a
 * single agent). Cap exists to prevent a runaway loop on bizarre
 * filesystem states.
 */
const MAX_COLLISION_SUFFIX = 99;

export async function persistPlanArchetypeMarkdown(
  input: PersistPlanArchetypeMarkdownInput,
): Promise<PersistPlanArchetypeMarkdownResult> {
  const agentId = input.agentId.trim();
  if (!agentId) {
    throw new Error("persistPlanArchetypeMarkdown: agentId required");
  }
  // Reject path-traversal characters in agentId. Session-key parsing
  // upstream should already produce safe ids, but defense-in-depth
  // here keeps a malformed id from escaping the plans directory.
  // Using \p{Cc} (Unicode "Other, Control") to satisfy the
  // no-control-regex lint rule while still rejecting C0/DEL controls.
  //
  // PR-11 review fix (Copilot #3105169607): also reject "." / ".."
  // / any agentId composed entirely of dots — `path.join(baseDir,
  // "..", "plans")` would escape the intended directory.
  // Additionally verify the resolved target stays within baseDir as
  // a belt-and-suspenders prefix check.
  if (/[\\/]/.test(agentId) || /\p{Cc}/u.test(agentId)) {
    throw new Error(`persistPlanArchetypeMarkdown: invalid agentId: ${JSON.stringify(agentId)}`);
  }
  if (agentId === "." || agentId === ".." || /^\.+$/.test(agentId)) {
    throw new Error(
      `persistPlanArchetypeMarkdown: invalid agentId (path-traversal): ${JSON.stringify(agentId)}`,
    );
  }

  const baseDir = input.baseDir ?? path.join(os.homedir(), ".openclaw", "agents");
  const agentDir = path.join(baseDir, agentId);
  const dir = path.join(agentDir, "plans");
  // PR-11 review M3: belt-and-suspenders confine — resolve the target
  // and verify it stays within baseDir. Catches any edge case the
  // syntactic check missed (e.g. agentId smuggling some Unicode
  // separator we didn't enumerate).
  //
  // Copilot review #68939 (2026-04-19): also reject symlinks at the
  // agent-dir and plans-dir levels, then validate containment using
  // realpath() (not just lexical resolve()). Pre-fix, a pre-existing
  // symlink like `~/.openclaw/agents/<agentId> -> /etc` would let
  // writes escape baseDir despite the syntactic agentId check (the
  // path component `<agentId>` is fine; the symlink target is the
  // escape vector). The new check stat()s each component, refuses
  // the operation if the component is a symlink, then realpath()s
  // both base and target before the prefix-match.
  const resolvedBase = path.resolve(baseDir);
  const resolvedDir = path.resolve(dir);
  if (!resolvedDir.startsWith(resolvedBase + path.sep) && resolvedDir !== resolvedBase) {
    throw new Error(
      `persistPlanArchetypeMarkdown: resolved path escapes baseDir: ${JSON.stringify(resolvedDir)}`,
    );
  }
  const rejectSymlinkIfPresent = async (targetPath: string, label: string): Promise<void> => {
    try {
      const stat = await fsp.lstat(targetPath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `persistPlanArchetypeMarkdown: ${label} must not be a symlink: ${JSON.stringify(targetPath)}`,
        );
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        throw err;
      }
    }
  };
  await fsp.mkdir(baseDir, { recursive: true });
  const realBase = await fsp.realpath(baseDir);
  await rejectSymlinkIfPresent(agentDir, "agent directory");
  await fsp.mkdir(agentDir, { recursive: true });
  const realAgentDir = await fsp.realpath(agentDir);
  if (!realAgentDir.startsWith(realBase + path.sep) && realAgentDir !== realBase) {
    throw new Error(
      `persistPlanArchetypeMarkdown: resolved agent directory escapes baseDir: ${JSON.stringify(realAgentDir)}`,
    );
  }
  await rejectSymlinkIfPresent(dir, "plans directory");
  await fsp.mkdir(dir, { recursive: true });
  const realDir = await fsp.realpath(dir);
  if (!realDir.startsWith(realBase + path.sep) && realDir !== realBase) {
    throw new Error(
      `persistPlanArchetypeMarkdown: resolved plans directory escapes baseDir: ${JSON.stringify(realDir)}`,
    );
  }

  const baseName = buildPlanFilename(input.title, input.now);
  // baseName ends with `.md`. For a 2nd-write of the same date+slug,
  // produce `<base>-2.md`; for the 3rd, `<base>-3.md`; etc.
  //
  // Copilot review #68939 (2026-04-19): atomic create with `wx`
  // (exclusive) flag instead of `existsSync` + `writeFile`. The
  // existsSync check was a TOCTOU race window — a parallel agent
  // call writing the same date+slug could land between the existence
  // check and our write, silently overwriting their plan. `wx` opens
  // with `O_CREAT | O_EXCL`, so the OS rejects the open with EEXIST
  // when the file already exists. We catch EEXIST and try the next
  // suffix in the same loop. All other errors propagate.
  const writeFileFn = input._writeFileForTest ?? fsp.writeFile;
  let candidateName = baseName;
  let n = 1;
  let absPath = path.join(dir, candidateName);
  while (n <= MAX_COLLISION_SUFFIX) {
    try {
      await writeFileFn(absPath, input.markdown, { encoding: "utf8", flag: "wx" });
      return { absPath, filename: candidateName };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "EEXIST") {
        n += 1;
        candidateName = baseName.replace(/\.md$/, `-${n}.md`);
        absPath = path.join(dir, candidateName);
        continue;
      }
      // R4 (C1 follow-up): classify recoverable system-admin errors
      // with a distinctive prefix so the caller's catch can surface
      // an actionable message instead of a generic "persist failed".
      // ENOSPC = disk full, EACCES = permissions, EIO = underlying
      // storage I/O error. All are remediable by the operator, not
      // by retrying the agent turn.
      if (code === "ENOSPC" || code === "EACCES" || code === "EIO") {
        throw new PlanPersistStorageError(
          `persistPlanArchetypeMarkdown: storage error (${code}) writing ${absPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          code,
        );
      }
      throw err;
    }
  }
  throw new Error(
    `persistPlanArchetypeMarkdown: collision-suffix cap reached (${MAX_COLLISION_SUFFIX}) for ${baseName}`,
  );
}

/**
 * Recoverable storage errors (disk full, permission denied, I/O
 * failure) surface as this class so the bridge can emit an
 * actionable operator-facing log message without confusing the path
 * with a genuine bug. Plan-mode treats these as non-fatal — the
 * plan approval still proceeds; only the durable audit artifact is
 * lost.
 */
export class PlanPersistStorageError extends Error {
  readonly code: "ENOSPC" | "EACCES" | "EIO";
  constructor(message: string, code: "ENOSPC" | "EACCES" | "EIO") {
    super(message);
    this.name = "PlanPersistStorageError";
    this.code = code;
  }
}
