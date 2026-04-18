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
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildPlanFilename } from "./plan-archetype-prompt.js";

export interface PersistPlanArchetypeMarkdownInput {
  agentId: string;
  /** Used to compute the filename slug. Falls back to "plan" inside buildPlanFilename. */
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
  if (/[\\/]/.test(agentId) || /\p{Cc}/u.test(agentId)) {
    throw new Error(`persistPlanArchetypeMarkdown: invalid agentId: ${JSON.stringify(agentId)}`);
  }

  const baseDir = input.baseDir ?? path.join(os.homedir(), ".openclaw", "agents");
  const dir = path.join(baseDir, agentId, "plans");
  await fsp.mkdir(dir, { recursive: true });

  const baseName = buildPlanFilename(input.title, input.now);
  // baseName ends with `.md`. For a 2nd-write of the same date+slug,
  // produce `<base>-2.md`; for the 3rd, `<base>-3.md`; etc.
  let candidateName = baseName;
  let n = 1;
  while (n <= MAX_COLLISION_SUFFIX && fs.existsSync(path.join(dir, candidateName))) {
    n += 1;
    candidateName = baseName.replace(/\.md$/, `-${n}.md`);
  }
  if (n > MAX_COLLISION_SUFFIX) {
    throw new Error(
      `persistPlanArchetypeMarkdown: collision-suffix cap reached (${MAX_COLLISION_SUFFIX}) for ${baseName}`,
    );
  }

  const absPath = path.join(dir, candidateName);
  await fsp.writeFile(absPath, input.markdown, "utf8");
  return { absPath, filename: candidateName };
}
