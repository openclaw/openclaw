import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import { sha256Hex } from "../../infra/crypto-digest.js";
import type { CliReusableSession, PreparedCliRunContext } from "./types.js";

function buildCliLogArgs(params: {
  args: string[];
  systemPromptArg?: string;
  modelArg?: string;
  imageArg?: string;
  argsPrompt?: string;
}): string[] {
  const logArgs: string[] = [];
  for (let i = 0; i < params.args.length; i += 1) {
    const arg = params.args[i] ?? "";
    if (arg === params.systemPromptArg) {
      const systemPromptValue = params.args[i + 1] ?? "";
      logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
      i += 1;
      continue;
    }
    if (arg === params.modelArg) {
      logArgs.push(arg, params.args[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === params.imageArg) {
      logArgs.push(arg, "<image>");
      i += 1;
      continue;
    }
    logArgs.push(arg);
  }
  if (params.argsPrompt) {
    const promptIndex = logArgs.indexOf(params.argsPrompt);
    if (promptIndex >= 0) {
      logArgs[promptIndex] = `<prompt:${params.argsPrompt.length} chars>`;
    }
  }
  return logArgs;
}
const CLI_ENV_AUTH_LOG_KEYS = [
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "ANTHROPIC_API_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_UNIX_SOCKET",
  "AZURE_OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "OPENAI_API_KEY",
  "OPENAI_STEIPETE_API_KEY",
  "OPENROUTER_API_KEY",
] as const;
const CLI_ENV_RUNTIME_LOG_KEYS = ["GEMINI_CLI_HOME", "GEMINI_CLI_SYSTEM_SETTINGS_PATH"] as const;
export const CLAUDE_SELECTED_AUTH_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);
export const NODE_CLAUDE_FORWARD_ENV_KEYS = new Set([
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
]);
export function resolveNodeClaudeAuthEnv(context: PreparedCliRunContext): Record<string, string> {
  const secretInput = context.preparedBackend.secretInput;
  if (!secretInput) {
    return {};
  }
  const descriptorEnv = context.preparedBackend.env ?? {};
  const requestEnv = Object.hasOwn(descriptorEnv, "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR")
    ? "CLAUDE_CODE_OAUTH_TOKEN"
    : Object.hasOwn(descriptorEnv, "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR")
      ? "ANTHROPIC_API_KEY"
      : undefined;
  if (!requestEnv) {
    return {};
  }
  const data = secretInput.createData();
  try {
    return { [requestEnv]: data.toString("utf8") };
  } finally {
    data.fill(0);
  }
}
export const CLI_BACKEND_PRESERVE_ENV = "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV";
export function parseCliBackendPreserveEnv(raw: string | undefined): Set<string> {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return new Set();
  }
  if (trimmed.startsWith("[")) {
    try {
      return new Set(filterStringEntries(JSON.parse(trimmed)));
    } catch {
      return new Set();
    }
  }
  return new Set(trimmed.split(/[,\s]+/).filter(Boolean));
}
function fingerprintCliSessionId(sessionId?: string): string {
  const trimmed = sessionId?.trim();
  if (!trimmed) {
    return "none";
  }
  return sha256Hex(trimmed).slice(0, 12);
}
function formatCliSessionReuseLogState(reusableSession: CliReusableSession): string {
  switch (reusableSession.mode) {
    case "reuse":
      return "reusable";
    case "reuse-with-drift":
      return `reusable-drift:${reusableSession.drift.reasons.join(",")}`;
    case "invalidate":
      return `invalidated:${reusableSession.invalidatedReason}`;
    case "none":
      return "none";
  }
  const exhaustive: never = reusableSession;
  return exhaustive;
}

export function buildCliExecLogLine(params: {
  provider: string;
  model: string;
  promptChars: number;
  trigger?: string;
  useResume: boolean;
  cliSessionId?: string;
  resolvedSessionId?: string;
  reusableSession: CliReusableSession;
  hasHistoryPrompt: boolean;
}): string {
  return [
    `cli exec: provider=${params.provider}`,
    `model=${params.model}`,
    `promptChars=${params.promptChars}`,
    `trigger=${params.trigger ?? "unknown"}`,
    `useResume=${params.useResume ? "true" : "false"}`,
    `session=${params.cliSessionId ? "present" : "none"}`,
    `resumeSession=${params.useResume ? fingerprintCliSessionId(params.resolvedSessionId) : "none"}`,
    `reuse=${formatCliSessionReuseLogState(params.reusableSession)}`,
    `historyPrompt=${params.hasHistoryPrompt ? "present" : "none"}`,
  ].join(" ");
}

function buildCliEnvAuthLog(childEnv: Record<string, string>): string {
  const formatKeys = (keys: readonly string[], labels: readonly string[]) => {
    const present = (env: Record<string, string | undefined>) =>
      keys.filter((key) => typeof env[key] === "string" && env[key].length > 0);
    const host = present(process.env);
    const child = present(childEnv);
    return [host, child, host.filter((key) => !child.includes(key))]
      .map((values, index) => `${labels[index]}=${values.join(",") || "none"}`)
      .join(" ");
  };
  return `${formatKeys(CLI_ENV_AUTH_LOG_KEYS, ["host", "child", "cleared"])} ${formatKeys(CLI_ENV_RUNTIME_LOG_KEYS, ["runtimeHost", "runtimeChild", "runtimeCleared"])}`;
}

export function logCliInvocation(params: {
  args: string[];
  command: string;
  env: Record<string, string>;
  systemPromptArg?: string;
  modelArg?: string;
  imageArg?: string;
  argsPrompt?: string;
  log: (message: string) => void;
}): void {
  const logArgs = buildCliLogArgs(params);
  params.log(`cli argv: ${params.command} ${logArgs.join(" ")}`);
  params.log(`cli env auth: ${buildCliEnvAuthLog(params.env)}`);
  if (params.env.OPENCLAW_MCP_TOKEN) {
    params.log(
      `cli env mcp: token=set capture=${params.env.OPENCLAW_MCP_CLI_CAPTURE_KEY ? "set" : "missing"}`,
    );
  }
}
