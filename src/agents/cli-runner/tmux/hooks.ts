import fs from "node:fs/promises";
import type { TmuxActiveRun, TmuxHookEvent, TmuxRuntimePaths } from "./types.js";

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function buildClaudeTmuxSettings(): Record<string, unknown> {
  return {
    autoMemoryEnabled: false,
    autoDreamEnabled: false,
    claudeMdExcludes: ["**/CLAUDE.md", "**/.claude/rules/**"],
    disableBackgroundAgents: true,
    disableRemoteControl: true,
  };
}

function buildCommandHook(paths: TmuxRuntimePaths, event: string) {
  return {
    type: "command",
    command: `node ${shellQuote(paths.hookWriterFile)} ${shellQuote(event)}`,
    timeout: event === "Stop" ? 10 : 5,
    suppressOutput: true,
  };
}

export function buildClaudeTmuxManagedSettings(paths: TmuxRuntimePaths): Record<string, unknown> {
  return {
    autoMemoryEnabled: false,
    autoDreamEnabled: false,
    allowManagedHooksOnly: true,
    disableBackgroundAgents: true,
    disableRemoteControl: true,
    hooks: {
      SessionStart: [{ hooks: [buildCommandHook(paths, "SessionStart")] }],
      UserPromptSubmit: [{ hooks: [buildCommandHook(paths, "UserPromptSubmit")] }],
      PreToolUse: [{ matcher: "*", hooks: [buildCommandHook(paths, "PreToolUse")] }],
      PostToolUse: [{ matcher: "*", hooks: [buildCommandHook(paths, "PostToolUse")] }],
      PostToolUseFailure: [
        { matcher: "*", hooks: [buildCommandHook(paths, "PostToolUseFailure")] },
      ],
      Stop: [{ hooks: [buildCommandHook(paths, "Stop")] }],
    },
  };
}

export async function writeClaudeTmuxRuntimeFiles(params: {
  paths: TmuxRuntimePaths;
  systemPrompt: string;
  hookMode: "managed" | "off";
}): Promise<{ managedSettingsJson?: string }> {
  await fs.writeFile(
    params.paths.settingsFile,
    `${JSON.stringify(buildClaudeTmuxSettings(), null, 2)}\n`,
    { mode: 0o600 },
  );
  await fs.writeFile(params.paths.systemPromptFile, params.systemPrompt, { mode: 0o600 });
  await writeHookWriter(params.paths);
  if (params.hookMode === "off") {
    return {};
  }
  const managed = buildClaudeTmuxManagedSettings(params.paths);
  const managedSettingsJson = JSON.stringify(managed);
  await fs.writeFile(params.paths.managedSettingsFile, `${JSON.stringify(managed, null, 2)}\n`, {
    mode: 0o600,
  });
  return { managedSettingsJson };
}

export async function writeActiveRun(
  paths: TmuxRuntimePaths,
  activeRun: TmuxActiveRun,
): Promise<void> {
  await fs.writeFile(paths.activeRunFile, `${JSON.stringify(activeRun, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function writeHookWriter(paths: TmuxRuntimePaths): Promise<void> {
  const script = `#!/usr/bin/env node
import fs from "node:fs";

const event = process.argv[2] || "unknown";
const activeRunFile = ${JSON.stringify(paths.activeRunFile)};
const eventsFile = ${JSON.stringify(paths.eventsFile)};

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let stdin = null;
  try {
    stdin = input.trim() ? JSON.parse(input) : null;
  } catch (error) {
    stdin = { parseError: String(error), raw: input };
  }
  let active = {};
  try {
    active = JSON.parse(fs.readFileSync(activeRunFile, "utf8"));
  } catch {}
  const record = {
    event,
    runId: active.runId,
    openclawSessionId: active.openclawSessionId,
    claudeSessionId: stdin && typeof stdin.session_id === "string" ? stdin.session_id : undefined,
    timestamp: Date.now(),
    stdin: stdin && typeof stdin === "object" ? stdin : undefined,
  };
  fs.appendFileSync(eventsFile, JSON.stringify(record) + "\\n", { encoding: "utf8" });
  process.stdout.write("{}\\n");
});
`;
  await fs.writeFile(paths.hookWriterFile, script, { mode: 0o700 });
  await fs.chmod(paths.hookWriterFile, 0o700);
}

export function parseHookEventLine(line: string): TmuxHookEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const event = typeof parsed.event === "string" ? parsed.event : "";
    if (!event || !HOOK_EVENTS.includes(event as (typeof HOOK_EVENTS)[number])) {
      return null;
    }
    const timestamp = typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now();
    return {
      event,
      timestamp,
      ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}),
      ...(typeof parsed.openclawSessionId === "string"
        ? { openclawSessionId: parsed.openclawSessionId }
        : {}),
      ...(typeof parsed.claudeSessionId === "string"
        ? { claudeSessionId: parsed.claudeSessionId }
        : {}),
      ...(parsed.stdin && typeof parsed.stdin === "object"
        ? { stdin: parsed.stdin as Record<string, unknown> }
        : {}),
    };
  } catch {
    return null;
  }
}
