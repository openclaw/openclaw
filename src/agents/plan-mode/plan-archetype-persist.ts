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
  const dir = path.join(baseDir, agentId, "plans");
  // PR-11 review M3: belt-and-suspenders confine — resolve the target
  // and verify it stays within baseDir. Catches any edge case the
  // syntactic check missed (e.g. agentId smuggling some Unicode
  // separator we didn't enumerate).
  const resolvedBase = path.resolve(baseDir);
  const resolvedDir = path.resolve(dir);
  if (!resolvedDir.startsWith(resolvedBase + path.sep) && resolvedDir !== resolvedBase) {
    throw new Error(
      `persistPlanArchetypeMarkdown: resolved path escapes baseDir: ${JSON.stringify(resolvedDir)}`,
    );
  }
  await fsp.mkdir(dir, { recursive: true });

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
  let candidateName = baseName;
  let n = 1;
  let absPath = path.join(dir, candidateName);
  while (n <= MAX_COLLISION_SUFFIX) {
    try {
      await fsp.writeFile(absPath, input.markdown, { encoding: "utf8", flag: "wx" });
      return { absPath, filename: candidateName };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EEXIST") {
        throw err;
      }
      n += 1;
      candidateName = baseName.replace(/\.md$/, `-${n}.md`);
      absPath = path.join(dir, candidateName);
    }
  }
  throw new Error(
    `persistPlanArchetypeMarkdown: collision-suffix cap reached (${MAX_COLLISION_SUFFIX}) for ${baseName}`,
  );
}
