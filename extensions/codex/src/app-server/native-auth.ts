import { CODEX_APP_SERVER_AUTH_MARKER } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgram,
} from "openclaw/plugin-sdk/windows-spawn";
import { readCodexPluginConfig } from "./config-parsing.js";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";
import { resolveManagedCodexAppServerStartOptions } from "./managed-binary.js";

const OPENAI_LOGIN_MODES: Readonly<Record<string, "oauth" | "token">> = {
  "Logged in using ChatGPT": "oauth",
  "Logged in using access token": "token",
  "Logged in using personal access token": "token",
};

/** Ask the selected native binary about its own store; retain no credential material. */
export async function probeCodexNativeAuth(params: {
  config?: OpenClawConfig;
  pluginConfig?: unknown;
  pluginRoot?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): ReturnType<NonNullable<ProviderPlugin["prepareSyntheticAuth"]>> {
  params.signal?.throwIfAborted();
  try {
    const pluginConfig = readCodexPluginConfig(
      params.pluginConfig ?? params.config?.plugins?.entries?.codex?.config,
    );
    const options = resolveCodexAppServerRuntimeOptions({ pluginConfig });
    // An explicitly isolated home or remote endpoint cannot borrow the operator's login.
    if (options.start.transport !== "stdio" || pluginConfig.appServer?.homeScope === "agent") {
      return undefined;
    }
    const start = await resolveManagedCodexAppServerStartOptions(options.start, {
      pluginRoot: params.pluginRoot,
    });
    if (start.transport !== "stdio") {
      return undefined;
    }
    const invocation = materializeWindowsSpawnProgram(
      resolveWindowsSpawnProgram({
        command: start.command,
        env: params.env ?? process.env,
        packageName: "@openai/codex",
      }),
      ["login", "status"],
    );
    const result = await runUtf8CommandWithTimeout([invocation.command, ...invocation.argv], {
      baseEnv: params.env ?? process.env,
      timeoutMs: 3_000,
      signal: params.signal,
      killProcessTree: true,
    });
    params.signal?.throwIfAborted();
    if (result.termination !== "exit" || result.code !== 0) {
      return undefined;
    }
    const line = `${result.stdout}\n${result.stderr}`
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value.startsWith("Logged in using "));
    const mode = line?.startsWith("Logged in using an API key - ")
      ? "api-key"
      : line
        ? OPENAI_LOGIN_MODES[line]
        : undefined;
    // Workload identity and Bedrock logins do not authorize an OpenAI route.
    return mode
      ? {
          apiKey: CODEX_APP_SERVER_AUTH_MARKER,
          source: "Codex native login",
          mode,
          nativeAuth: { runtime: "codex", mode },
        }
      : undefined;
  } catch {
    params.signal?.throwIfAborted();
    return undefined;
  }
}
