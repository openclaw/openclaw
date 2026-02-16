import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { execFile, spawn } from "node:child_process";

type HookDefinition = {
  tool: string;
  event?: "after_tool_call" | "before_tool_call";
  command: string;
  background?: boolean;
  timeoutMs?: number;
  onlyOnSuccess?: boolean;
};

type PluginConfig = {
  hooks?: HookDefinition[];
};

function matchesToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === toolName;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(toolName);
}

function runCommand(
  command: string,
  env: Record<string, string>,
  opts: { timeoutMs: number; background: boolean },
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  const fullEnv = { ...process.env, ...env };
  const child = spawn("sh", ["-c", command], {
    env: fullEnv,
    stdio: "ignore",
    detached: opts.background,
    timeout: opts.timeoutMs,
  });

  if (opts.background) {
    child.unref();
  } else {
    child.on("error", (err) => {
      log.warn(`tool-hooks command failed: ${command} — ${err.message}`);
    });
    child.on("exit", (code) => {
      if (code && code !== 0) {
        log.warn(`tool-hooks command exited with code ${code}: ${command}`);
      }
    });
  }
}

const toolHooksPlugin = {
  id: "tool-hooks",
  name: "Tool Hooks",
  description:
    "Run shell commands after (or before) tool calls. Useful for tracking, logging, syncing, or triggering side effects when specific tools are used.",
  kind: "extension" as const,
  configSchema: {},
  register(api: OpenClawPluginApi) {
    const config = (api.config ?? {}) as PluginConfig;
    const hooks = config.hooks;

    if (!hooks || hooks.length === 0) {
      return;
    }

    const afterHooks = hooks.filter((h) => (h.event ?? "after_tool_call") === "after_tool_call");
    const beforeHooks = hooks.filter((h) => h.event === "before_tool_call");

    if (afterHooks.length > 0) {
      api.on("after_tool_call", (event, ctx) => {
        const toolName = event.toolName ?? "";
        for (const hook of afterHooks) {
          if (!matchesToolPattern(hook.tool, toolName)) continue;
          if (hook.onlyOnSuccess && event.error) continue;

          const env: Record<string, string> = {
            TOOL_NAME: toolName,
            TOOL_PARAMS: JSON.stringify(event.params ?? {}),
            TOOL_RESULT: typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? ""),
            TOOL_DURATION_MS: String(event.durationMs ?? 0),
            AGENT_ID: ctx?.agentId ?? "",
            SESSION_KEY: ctx?.sessionKey ?? "",
          };
          if (event.error) {
            env.TOOL_ERROR = event.error;
          }

          runCommand(
            hook.command,
            env,
            {
              timeoutMs: hook.timeoutMs ?? 10_000,
              background: hook.background ?? true,
            },
            api.logger,
          );
        }
      });
    }

    if (beforeHooks.length > 0) {
      api.on("before_tool_call", (event, ctx) => {
        const toolName = event.toolName ?? "";
        for (const hook of beforeHooks) {
          if (!matchesToolPattern(hook.tool, toolName)) continue;

          const env: Record<string, string> = {
            TOOL_NAME: toolName,
            TOOL_PARAMS: JSON.stringify(event.params ?? {}),
            AGENT_ID: ctx?.agentId ?? "",
            SESSION_KEY: ctx?.sessionKey ?? "",
          };

          runCommand(
            hook.command,
            env,
            {
              timeoutMs: hook.timeoutMs ?? 10_000,
              background: hook.background ?? true,
            },
            api.logger,
          );
        }
      });
    }

    api.logger.info(`tool-hooks: registered ${afterHooks.length} after + ${beforeHooks.length} before hooks`);
  },
};

export default toolHooksPlugin;
