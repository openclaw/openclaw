import { addAbortListener } from "node:events";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import { CLAUDE_CLI_CLEAR_ENV } from "./cli-constants.js";
import { createClaudeCliTransport, type ClaudeCliTransport } from "./cli-transport.js";

// Native initialization can be slow on cold disks; it never runs on a picker request.
const INITIALIZE_TIMEOUT_MS = 30_000;
const NATIVE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Discover the native menu without submitting a user message or starting a turn. */
export async function discoverClaudeCliModels(params: {
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<ModelDefinitionConfig[]> {
  params.signal?.throwIfAborted();
  const env = Object.fromEntries(
    Object.entries(params.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  for (const name of CLAUDE_CLI_CLEAR_ENV) {
    delete env[name];
  }
  const program = resolveWindowsSpawnProgram({
    command: "claude",
    env,
    packageName: "@anthropic-ai/claude-code",
  });
  const invocation = materializeWindowsSpawnProgram(program, [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompt-tool",
    "stdio",
    "--setting-sources",
    "user",
    "--settings",
    '{"disableAllHooks":true,"enabledPlugins":{}}',
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--tools",
    "",
  ]);
  const deadline = new AbortController();
  const timeout = setTimeout(
    () => deadline.abort(new Error("Claude CLI model discovery timed out.")),
    INITIALIZE_TIMEOUT_MS,
  );
  timeout.unref();
  const signal = params.signal
    ? AbortSignal.any([params.signal, deadline.signal])
    : deadline.signal;
  const context = {
    command: invocation.command,
    args: invocation.argv,
    cwd: env.HOME ?? process.cwd(),
    env,
    abortSignal: signal,
    assertCurrent: () => signal.throwIfAborted(),
  };
  let transport: ClaudeCliTransport | undefined;
  let abortListener: Disposable | undefined;
  try {
    transport = createClaudeCliTransport({
      context,
      args: invocation.argv,
      currentContext: () => (signal.aborted ? undefined : context),
      initialize: { hooks: {} },
      onMessage: async () => {},
      onRequest: async () => {
        throw new Error("Model discovery cannot authorize native requests.");
      },
      onError: () => {},
    });
    abortListener = addAbortListener(signal, () => transport?.close());
    const response = await transport.initialize();
    signal.throwIfAborted();
    if (!Array.isArray(response.models)) {
      throw new Error("Claude CLI initialization did not return a model menu.");
    }
    const models = new Map<string, ModelDefinitionConfig>();
    for (const option of response.models) {
      if (
        !isRecord(option) ||
        typeof option.resolvedModel !== "string" ||
        !option.resolvedModel.trim()
      ) {
        continue;
      }
      const id = option.resolvedModel.trim();
      if (models.has(id)) {
        continue;
      }
      const levels = NATIVE_EFFORT_LEVELS.filter(
        (level) =>
          Array.isArray(option.supportedEffortLevels) &&
          option.supportedEffortLevels.includes(level),
      );
      models.set(id, {
        id,
        name: typeof option.displayName === "string" ? option.displayName : id,
        reasoning: levels.length > 0,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        maxTokens: 128_000,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          ...Object.fromEntries(
            NATIVE_EFFORT_LEVELS.map((level) => [level, levels.includes(level) ? level : null]),
          ),
        },
      });
    }
    return [...models.values()];
  } finally {
    clearTimeout(timeout);
    abortListener?.[Symbol.dispose]();
    transport?.close();
    await transport?.waitForExit();
  }
}
