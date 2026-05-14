import type { CliBackendConfig } from "../../../config/types.js";

const FLAGS_WITH_VALUE = new Set([
  "-p",
  "--print",
  "--output-format",
  "--input-format",
  "--append-system-prompt",
  "--append-system-prompt-file",
  "--system-prompt",
  "--system-prompt-file",
  "--setting-sources",
  "--settings",
  "--managed-settings",
  "--permission-mode",
  "--session-id",
  "--model",
]);

const DROP_FLAGS = new Set([
  "-p",
  "--print",
  "--bare",
  "--include-partial-messages",
  "--verbose",
  "--dangerously-skip-permissions",
  "--replay-user-messages",
  "--no-session-persistence",
]);

function shouldDropEqualsArg(arg: string): boolean {
  return (
    arg.startsWith("--output-format=") ||
    arg.startsWith("--input-format=") ||
    arg.startsWith("--append-system-prompt=") ||
    arg.startsWith("--append-system-prompt-file=") ||
    arg.startsWith("--system-prompt=") ||
    arg.startsWith("--system-prompt-file=") ||
    arg.startsWith("--setting-sources=") ||
    arg.startsWith("--settings=") ||
    arg.startsWith("--managed-settings=") ||
    arg.startsWith("--permission-mode=") ||
    arg.startsWith("--session-id=") ||
    arg.startsWith("--model=")
  );
}

export function buildClaudeTmuxArgs(params: {
  backend: CliBackendConfig;
  baseArgs?: string[];
  modelId: string;
  settingsFile: string;
  managedSettingsJson?: string;
  systemPromptFile: string;
  sessionId?: string;
}): string[] {
  const args: string[] = [];
  const source = params.baseArgs ?? [];
  for (let i = 0; i < source.length; i += 1) {
    const arg = source[i] ?? "";
    if (DROP_FLAGS.has(arg) || shouldDropEqualsArg(arg)) {
      continue;
    }
    if (FLAGS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    args.push(arg);
  }

  args.push("--settings", params.settingsFile);
  if (params.managedSettingsJson) {
    args.push("--managed-settings", params.managedSettingsJson);
  }
  args.push("--setting-sources", "");
  args.push("--append-system-prompt-file", params.systemPromptFile);
  args.push("--permission-mode", "bypassPermissions");
  if (params.backend.modelArg && params.modelId) {
    args.push(params.backend.modelArg, params.modelId);
  }
  if (params.backend.sessionArg && params.sessionId) {
    args.push(params.backend.sessionArg, params.sessionId);
  }
  return args;
}
