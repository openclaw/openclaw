import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, generatePrefixedId } from "../tools/common.js";
import { SandboxManager } from "./manager.js";
import type { ExecutionSandboxConfig } from "./types.js";

export function registerExecutionSandbox(
  api: OpenClawPluginApi,
  config: { sandbox?: ExecutionSandboxConfig },
): void {
  const log = api.logger;
  const sbConfig = config.sandbox ?? {};
  const manager = new SandboxManager(sbConfig);

  api.registerTool({
    name: "sandbox_exec",
    label: "Execute in Sandbox",
    description: "Execute a command in an isolated sandbox environment (local, Docker, or SSH).",
    parameters: Type.Object({
      command: Type.String({ description: "Command to execute" }),
      task_id: Type.Optional(Type.String({ description: "Task ID for sandbox reuse" })),
      backend: Type.Optional(Type.String({ description: "Backend: local, docker, ssh" })),
      cwd: Type.Optional(Type.String({ description: "Working directory" })),
      timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms" })),
    }),
    async execute(
      _id: string,
      params: {
        command: string;
        task_id?: string;
        backend?: string;
        cwd?: string;
        timeout_ms?: number;
      },
    ) {
      const taskId = params.task_id ?? generatePrefixedId("sandbox");
      const sandbox = await manager.getOrCreate(taskId, params.backend);
      const result = await sandbox.exec(params.command, {
        cwd: params.cwd,
        timeoutMs: params.timeout_ms,
      });
      const output = [
        `[${result.backend}] Exit code: ${result.exitCode} (${result.durationMs}ms)`,
        result.stdout ? `stdout:\n${result.stdout.slice(0, 4000)}` : "",
        result.stderr ? `stderr:\n${result.stderr.slice(0, 2000)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return textResult(output);
    },
  } as AnyAgentTool);

  api.registerTool({
    name: "sandbox_status",
    label: "Sandbox Status",
    description: "List active sandbox environments.",
    parameters: Type.Object({}),
    async execute() {
      const active = manager.getActiveSandboxes();
      if (active.length === 0) return textResult("No active sandboxes.");
      const lines = active.map((s) => `  ${s.taskId} -> ${s.backend}`);
      return textResult(`Active sandboxes (${active.length}):\n${lines.join("\n")}`);
    },
  } as AnyAgentTool);

  api.registerTool({
    name: "sandbox_destroy",
    label: "Destroy Sandbox",
    description: "Destroy a specific sandbox or all sandboxes.",
    parameters: Type.Object({
      all: Type.Optional(Type.Boolean({ description: "Destroy all sandboxes" })),
    }),
    async execute(_id: string, params: { all?: boolean }) {
      if (params.all) {
        await manager.destroyAll();
        return textResult("All sandboxes destroyed.");
      }
      return textResult("Specify all=true to destroy all sandboxes.");
    },
  } as AnyAgentTool);

  log.info(
    `[sandbox] Execution sandbox initialized (default backend: ${sbConfig.defaultBackend ?? "local"})`,
  );
}

export { SandboxManager } from "./manager.js";
export { LocalBackend } from "./backends/local.js";
export { DockerBackend } from "./backends/docker.js";
