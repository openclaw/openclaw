import { mkdirSync, existsSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Expands ~ to the user's home directory and ensures the directory exists.
 * Also creates a minimal accounts.toml file if it doesn't exist,
 * as required by the Delta.Chat RPC server.
 */
export function ensureDataDir(dataDir: string): string {
  // Expand ~ to home directory
  const expanded = dataDir.startsWith("~") ? homedir() + dataDir.slice(1) : dataDir;
  // Ensure the directory exists
  if (!existsSync(expanded)) {
    mkdirSync(expanded, { recursive: true });
  }

  // Create accounts.toml if it doesn't exist
  // The Delta.Chat RPC server expects this file to exist
  const accountsTomlPath = join(expanded, "accounts.toml");
  if (!existsSync(accountsTomlPath)) {
    const accountsTomlContent = `selected_account = 0
next_id = 1
accounts = []
`;
    writeFileSync(accountsTomlPath, accountsTomlContent, "utf8");
  }

  return expanded;
}

/**
 * Copies the OpenClaw avatar file to the Delta.Chat data directory
 * and returns the path to the copied avatar file.
 * Delta.Chat requires JPEG or PNG format for avatars (not SVG).
 */
export function copyAvatarToDataDir(dataDir: string): string | null {
  try {
    // Path to the OpenClaw avatar in the workspace
    // Delta.Chat requires JPEG or PNG format, so we use apple-touch-icon.png
    // In ESM, we need to use import.meta.url to get the current module's path
    const currentModulePath = fileURLToPath(import.meta.url);
    const currentDir = dirname(currentModulePath);
    // Go back 3 levels from /Users/alanz/src/openclaw/extensions/deltachat/src
    // to reach /Users/alanz/src/openclaw
    const workspaceRoot = resolve(currentDir, "../../..");
    const avatarSourcePath = join(workspaceRoot, "ui", "public", "apple-touch-icon.png");

    // Check if the source avatar file exists
    if (!existsSync(avatarSourcePath)) {
      return null;
    }

    // Ensure the data directory exists
    const expanded = dataDir.startsWith("~") ? homedir() + dataDir.slice(1) : dataDir;
    if (!existsSync(expanded)) {
      mkdirSync(expanded, { recursive: true });
    }

    // Copy the avatar to the data directory
    const avatarDestPath = join(expanded, "openclaw-avatar.png");
    copyFileSync(avatarSourcePath, avatarDestPath);

    return avatarDestPath;
  } catch {
    // Silently fail if avatar copy fails - it's not critical
    return null;
  }
}
