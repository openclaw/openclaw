import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";
import { CLAUDE_RESTRICTED_SETTINGS } from "./cli-shared.js";

/** Relocate only the prepared allowlist, retaining the last flag settings' policy. */
export async function relocateClaudeCliAllowlist(args: string[]) {
  const allowedIndex = args.lastIndexOf("--allowedTools");
  const allowed = args[allowedIndex + 1];
  if (allowedIndex < 0 || !allowed) {
    return undefined;
  }
  let settingsIndex = -1;
  let settingsWidth = 0;
  let value = "{}";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--settings") {
      settingsIndex = index;
      settingsWidth = 2;
      value = args[++index] ?? "";
    } else if (args[index]?.startsWith("--settings=")) {
      settingsIndex = index;
      settingsWidth = 1;
      value = args[index]!.slice("--settings=".length);
    }
  }
  // Only our path-independent projection may move. Caller-owned settings can
  // contain permission/sandbox paths anchored at the settings file's directory.
  const settings = value === "{}" ? {} : CLAUDE_RESTRICTED_SETTINGS;
  if (value !== JSON.stringify(settings)) {
    return undefined;
  }
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-claude-allowlist-",
  });
  try {
    const file = await workspace.writeJson("settings.json", {
      ...settings,
      permissions: { allow: allowed.split(",") },
    });
    return {
      args: [
        ...args.filter(
          (_, index) =>
            index !== allowedIndex &&
            index !== allowedIndex + 1 &&
            !(index >= settingsIndex && index < settingsIndex + settingsWidth),
        ),
        "--settings",
        file,
      ],
      cleanup: () => workspace.cleanup(),
    };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}
