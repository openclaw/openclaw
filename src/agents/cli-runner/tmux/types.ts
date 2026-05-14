import type { CliBackendConfig, CliTmuxExecutionConfig } from "../../../config/types.js";

export type NormalizedTmuxConfig = Required<
  Pick<
    CliTmuxExecutionConfig,
    | "sessionNamePrefix"
    | "startupTimeoutMs"
    | "turnIdleMs"
    | "captureLines"
    | "stopOnAbort"
    | "memoryMode"
    | "hookMode"
    | "authMode"
  >
> &
  Pick<CliTmuxExecutionConfig, "runtimeDir"> & {
    turnTimeoutMs: number;
  };

export type TmuxRuntimePaths = {
  rootDir: string;
  activeRunFile: string;
  eventsFile: string;
  paneLogFile: string;
  launcherFile: string;
  managedSettingsFile: string;
  settingsFile: string;
  systemPromptFile: string;
  hookWriterFile: string;
  promptBufferFile: string;
  metadataFile: string;
};

export type TmuxMetadata = {
  backendId: string;
  workspaceDir: string;
  sessionName: string;
  launchHash: string;
  model: string;
  systemPromptHash: string;
  mcpConfigHash?: string;
  authProfileId?: string;
  memoryMode: NormalizedTmuxConfig["memoryMode"];
  hookMode: NormalizedTmuxConfig["hookMode"];
  createdAt: number;
  lastUsedAt: number;
};

export type TmuxEnsureSessionResult = {
  created: boolean;
};

export type TmuxActiveRun = {
  runId: string;
  openclawSessionId: string;
  cliSessionId?: string;
  startedAt: number;
  promptHash: string;
  turnIndex: number;
};

export type TmuxHookEvent = {
  event: string;
  runId?: string;
  openclawSessionId?: string;
  claudeSessionId?: string;
  timestamp: number;
  stdin?: Record<string, unknown>;
};

export type TmuxCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export type TmuxExecutionInput = {
  backend: CliBackendConfig;
  backendId: string;
  workspaceDir: string;
  sessionId: string;
  cliSessionId?: string;
  runId: string;
  modelId: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  env: Record<string, string>;
  mcpConfigHash?: string;
  authProfileId?: string;
  abortSignal?: AbortSignal;
  onSystemInit?: (payload: { subtype: string; sessionId?: string }) => void;
  onAssistantTurn?: (text: string) => void;
  onToolUseEvent?: (payload: { name: string; toolUseId?: string; input?: unknown }) => void;
  onToolResult?: (payload: { toolUseId?: string; text?: string; isError?: boolean }) => void;
};
