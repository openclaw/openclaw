import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir, tempWorkspaceSync } from "openclaw/plugin-sdk/temp-path";

const PROTOCOL_FLAGS = new Set([
  "-p",
  "--print",
  "--verbose",
  "--include-partial-messages",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
]);
const PROTOCOL_VALUE_FLAGS = new Set([
  "--output-format",
  "--input-format",
  "--permission-prompt-tool",
  "--permission-mode",
  "--model",
  "--session-id",
  "--resume",
  "-r",
  "--append-system-prompt-file",
  "--append-system-prompt",
  "--system-prompt-file",
  "--system-prompt",
]);
const TOOL_FLAGS = new Set(["--tools", "--allowedTools", "--allowed-tools"]);
const CLAUDE_SETTINGS_ARG = "--settings";
// Windows caps a spawned command line near 32,767 characters; a large
// tool-availability allow list overflows that budget inline and surfaces as
// spawn ENAMETOOLONG. Past this size, carry the allow list in a temporary
// Claude settings file instead: permissions.allow is the native settings
// equivalent of --allowedTools, and the file path keeps argv short on every
// platform.
const ALLOWED_TOOLS_INLINE_CHAR_BUDGET = 8 * 1024;

type PreparedClaudeCliTransportArgs = {
  args: string[];
  excludeDynamicSections: boolean;
  /** Releases the temporary settings file once the transport process closes. */
  cleanup?: () => void;
};

function parseInlineClaudeSettings(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Move an oversized allow list off argv into a temporary settings file. */
function relocateApprovedToolsToSettingsFile(
  args: string[],
  approvedTools: string[],
): { cleanup: () => void } {
  // Claude Code honors a single --settings value, so merge into the inline
  // settings the restricted execution projection already passed instead of
  // appending a second flag that would shadow them.
  let settingsIndex = -1;
  let settingsConsumesValue = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === CLAUDE_SETTINGS_ARG && typeof args[index + 1] === "string") {
      settingsIndex = index;
      settingsConsumesValue = true;
      break;
    }
    if (arg.startsWith(CLAUDE_SETTINGS_ARG + "=")) {
      settingsIndex = index;
      break;
    }
  }
  let baseSettings: Record<string, unknown> = {};
  let splicedSettings: string[] = [];
  if (settingsIndex >= 0) {
    const raw = settingsConsumesValue
      ? args[settingsIndex + 1]
      : args[settingsIndex]!.slice(CLAUDE_SETTINGS_ARG.length + 1);
    const parsed = parseInlineClaudeSettings(raw);
    if (parsed === undefined) {
      // A --settings file path or unrecognized value stays authoritative;
      // keep the historical inline allow list for that configuration.
      args.push("--allowedTools", approvedTools.join(","));
      return { cleanup: () => {} };
    }
    baseSettings = parsed;
    splicedSettings = args.splice(settingsIndex, settingsConsumesValue ? 2 : 1);
  }
  let settingsPath: string;
  let cleanup: () => void;
  try {
    const workspace = tempWorkspaceSync({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-claude-cli-settings-",
    });
    const basePermissions = isRecord(baseSettings.permissions) ? baseSettings.permissions : {};
    settingsPath = workspace.writeJson("settings.json", {
      ...baseSettings,
      permissions: { ...basePermissions, allow: approvedTools },
    });
    let cleaned = false;
    cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      try {
        workspace.cleanup();
      } catch {
        // Temp cleanup is best effort; the OS sweeps the temp root eventually.
      }
    };
  } catch {
    // If the temp file cannot be written, restore the historical inline argv
    // rather than failing the run in a new way.
    if (splicedSettings.length > 0) {
      args.splice(settingsIndex, 0, ...splicedSettings);
    }
    args.push("--allowedTools", approvedTools.join(","));
    return { cleanup: () => {} };
  }
  args.push(CLAUDE_SETTINGS_ARG, settingsPath);
  return { cleanup };
}

/** Keep prepared CLI arguments, replacing only transport and admission-owned policy. */
export function prepareClaudeCliTransportArgs(
  context: CliBackendExecuteContext,
): PreparedClaudeCliTransportArgs {
  const args: string[] = [];
  const allowedTools: string[] = [];
  let tools: string[] | undefined;
  let settingSources = "user";
  let excludeDynamicSections = false;
  let cleanup: (() => void) | undefined;
  for (let index = 0; index < context.args.length; index += 1) {
    const raw = context.args[index]!;
    const equals = raw.indexOf("=");
    const flag = equals < 0 ? raw : raw.slice(0, equals);
    if (PROTOCOL_FLAGS.has(flag)) {
      continue;
    }
    if (flag === "--exclude-dynamic-system-prompt-sections") {
      excludeDynamicSections = true;
      continue;
    }
    if (!PROTOCOL_VALUE_FLAGS.has(flag) && !TOOL_FLAGS.has(flag) && flag !== "--setting-sources") {
      args.push(raw);
      continue;
    }
    const value = equals < 0 ? context.args[++index] : raw.slice(equals + 1);
    if (value === undefined) {
      throw new Error(`Claude CLI cannot preserve ${flag} without its value.`);
    }
    if (PROTOCOL_VALUE_FLAGS.has(flag)) {
      continue;
    }
    if (flag === "--setting-sources") {
      if (value !== "" && value !== "user") {
        throw new Error("Claude CLI settings must be limited to user settings.");
      }
      settingSources = value;
      continue;
    }
    const values = [value];
    if (equals < 0) {
      while (index + 1 < context.args.length && !context.args[index + 1]?.startsWith("-")) {
        values.push(context.args[++index]!);
      }
    }
    const names = values.flatMap((entry) =>
      entry
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    );
    if (flag === "--tools") {
      tools = names;
    } else {
      // Native actions must pass the host hooks, even if argv requested automatic approval.
      allowedTools.push(...names.filter((name) => name.startsWith("mcp__openclaw__")));
    }
  }
  let approvedTools = [...new Set(allowedTools)];
  if (context.toolAvailability) {
    tools = [...context.toolAvailability.native];
    approvedTools = context.toolAvailability.openClaw
      .map((name) => `mcp__openclaw__${name}`)
      .filter((name) => allowedTools.includes(name) || allowedTools.includes("mcp__openclaw__*"));
  }
  args.push(
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-prompt-tool",
    "stdio",
    "--permission-mode",
    "default",
    "--setting-sources",
    settingSources,
    "--model",
    context.modelId,
  );
  if (tools) {
    args.push("--tools", tools.join(","));
  }
  if (approvedTools.length) {
    const inlineAllowedTools = approvedTools.join(",");
    if (inlineAllowedTools.length <= ALLOWED_TOOLS_INLINE_CHAR_BUDGET) {
      args.push("--allowedTools", inlineAllowedTools);
    } else {
      cleanup = relocateApprovedToolsToSettingsFile(args, approvedTools).cleanup;
    }
  }
  if (context.sessionId) {
    args.push(context.useResume ? "--resume" : "--session-id", context.sessionId);
  }
  return cleanup === undefined
    ? { args, excludeDynamicSections }
    : { args, excludeDynamicSections, cleanup };
}
