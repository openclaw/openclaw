/**
 * Maps openclaw session files to SDK session IDs for conversation resumption.
 *
 * The SDK manages its own session persistence. This bridge stores the SDK
 * session ID alongside openclaw's session file so that subsequent runs can
 * resume the same SDK session via `query({ options: { resume: sessionId } })`.
 */

import fs from "node:fs";
import path from "node:path";

function sidecarPath(sessionFile: string): string {
  return `${sessionFile}.sdk-session`;
}

/**
 * Store the SDK session ID for a given openclaw session file.
 */
export function storeSdkSessionId(sessionFile: string, sdkSessionId: string): void {
  try {
    const dir = path.dirname(sessionFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sidecarPath(sessionFile), sdkSessionId, "utf-8");
  } catch {
    // Non-fatal: failing to persist the session ID just means we can't resume.
  }
}

/**
 * Load the SDK session ID for a given openclaw session file.
 * Returns undefined if no stored session ID exists.
 */
export function loadSdkSessionId(sessionFile: string): string | undefined {
  try {
    const id = fs.readFileSync(sidecarPath(sessionFile), "utf-8").trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Delete the stored SDK session ID (e.g., on /reset or /new).
 */
export function clearSdkSessionId(sessionFile: string): void {
  try {
    fs.unlinkSync(sidecarPath(sessionFile));
  } catch {
    // Ignore if file doesn't exist.
  }
}
