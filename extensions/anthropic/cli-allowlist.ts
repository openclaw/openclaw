import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir, tempWorkspace } from "openclaw/plugin-sdk/temp-path";

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
  let settings: unknown;
  try {
    settings = JSON.parse(value);
  } catch {
    // A caller-owned file or invalid JSON keeps its existing invocation/error.
    return undefined;
  }
  if (!isRecord(settings)) {
    return undefined;
  }
  const permissions = settings.permissions === undefined ? {} : settings.permissions;
  if (!isRecord(permissions)) {
    return undefined;
  }
  const allow = permissions.allow === undefined ? [] : permissions.allow;
  if (!Array.isArray(allow) || !allow.every((rule) => typeof rule === "string")) {
    return undefined;
  }
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-claude-allowlist-",
  });
  try {
    const file = await workspace.writeJson("settings.json", {
      ...settings,
      permissions: { ...permissions, allow: [...allow, ...allowed.split(",")] },
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
