import fs from "node:fs/promises";
import path from "node:path";
import { canonicalUserFileDir, isAppUserSession, resolveAppUserId } from "./app-user-workspace.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

/**
 * Per-user `app_profile` context injection (per-user-profile plan, Phase 3).
 *
 * For an app-user session, the agent should always know who it is talking to
 * without being reminded. This module reads the chatting user's per-user file
 * (`workspace/users/<appUserId>.md`), extracts the `app_profile` section that
 * the Havaya app seeds and the agent maintains (via `save_user_section`), and
 * surfaces it as a synthetic `APP_PROFILE.md` bootstrap context file injected
 * into the system prompt EVERY turn.
 *
 * First-class in gateway bootstrap assembly (not a host hook): app-session-only,
 * zero-config, byte-size-bounded. Telegram / no-appUserId sessions are no-ops.
 */

/** Synthetic context-file name shown to the model as `## APP_PROFILE.md`. */
export const APP_PROFILE_CONTEXT_NAME = "APP_PROFILE.md";

/**
 * Hard byte cap for the injected profile. Mirrors the writer's
 * `SECTION_CONTENT_BYTE_CAPS.app_profile` (save-user-section.ts) and the
 * dashboard `APP_PROFILE_MAX_BYTES`. Defense-in-depth: an admin/raw-edited file
 * may bypass the writer cap, so clamp again before injecting every turn.
 */
export const APP_PROFILE_MAX_BYTES = 2 * 1024;

/**
 * Extract the inner text of the `app_profile` marker section. Fail closed:
 * returns null when the section is absent, malformed (start without end), or
 * ambiguous (duplicate markers) — never guesses.
 *
 * CROSS-REPO CONTRACT: the marker strings must stay byte-identical to the writer
 * (`upsertSection` in src/agents/tools/save-user-section.ts) and the dashboard
 * (`extractSection` in lib/user-file-core.ts); change all three together.
 */
export function extractAppProfileSection(fileContent: string): string | null {
  const start = "<!-- app:app_profile:start -->";
  const end = "<!-- app:app_profile:end -->";
  const firstStart = fileContent.indexOf(start);
  if (firstStart === -1) return null;
  const firstEnd = fileContent.indexOf(end, firstStart + start.length);
  if (firstEnd === -1) return null;
  if (
    fileContent.indexOf(start, firstStart + start.length) !== -1 ||
    fileContent.indexOf(end, firstEnd + end.length) !== -1
  ) {
    return null; // ambiguous duplicate markers → fail closed
  }
  const inner = fileContent.slice(firstStart + start.length, firstEnd).trim();
  return inner || null;
}

/**
 * Bound `content` to {@link APP_PROFILE_MAX_BYTES} on a UTF-8 byte boundary,
 * dropping a truncated trailing multi-byte char.
 */
export function clampAppProfile(content: string, maxBytes = APP_PROFILE_MAX_BYTES): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  let s = Buffer.from(content, "utf8").subarray(0, maxBytes).toString("utf8");
  if (s.endsWith("�")) s = s.slice(0, -1);
  return s;
}

/**
 * Pure: build the synthetic `APP_PROFILE.md` bootstrap file from a per-user
 * file's raw content, or null when there is no usable profile. The `path` is a
 * bare filename (renders as `## APP_PROFILE.md`) so the on-disk `users/<id>.md`
 * location never leaks into the prompt.
 */
export function buildAppProfileContextFile(rawFileContent: string): WorkspaceBootstrapFile | null {
  const body = extractAppProfileSection(rawFileContent);
  if (!body) return null;
  return {
    name: APP_PROFILE_CONTEXT_NAME,
    path: APP_PROFILE_CONTEXT_NAME,
    content: clampAppProfile(body),
    missing: false,
  } as unknown as WorkspaceBootstrapFile;
}

/**
 * Append the per-user `APP_PROFILE.md` context file when the session is an
 * app-user session with a resolvable `appUserId` and a non-empty `app_profile`
 * section on disk. No-op (returns `files` unchanged) for Telegram / no-appUserId
 * sessions, a missing/unreadable file, or an empty/malformed section.
 *
 * `workspaceDir` MUST be the shared agent home (where `users/<id>.md` lives),
 * not a jailed per-user cwd; `sessionKey` MUST be the real session key (the
 * `:app:` marker and the persisted `appUserId` live on it).
 */
export async function appendAppProfileBootstrapFile(
  files: WorkspaceBootstrapFile[],
  params: { workspaceDir: string; sessionKey?: string },
): Promise<WorkspaceBootstrapFile[]> {
  if (!isAppUserSession(params.sessionKey)) return files;
  const appUserId = resolveAppUserId(params.sessionKey);
  if (!appUserId) return files;

  const filePath = path.join(canonicalUserFileDir(params.workspaceDir), `${appUserId}.md`);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return files; // lazily provisioned — absent until the agent/seed writes it
  }

  const contextFile = buildAppProfileContextFile(raw);
  return contextFile ? [...files, contextFile] : files;
}
