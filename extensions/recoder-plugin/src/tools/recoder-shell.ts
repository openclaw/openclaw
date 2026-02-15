/**
 * Recoder Shell Tool
 *
 * Execute shell commands in sandbox containers.
 */

import { Type } from "@sinclair/typebox";

import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { jsonResult, readStringParam, readNumberParam } from "../../../../src/agents/tools/common.js";

import type { RecoderPluginConfig } from "../types/index.js";
import { DockerClient } from "../services/docker-client.js";
import { getActiveProjectId, getProject } from "../services/session-state.js";

export function createRecoderShellTool(api: OpenClawPluginApi): AnyAgentTool {
  const config = (api.pluginConfig ?? {}) as RecoderPluginConfig;

  return {
    name: "recoder_shell",
    label: "Recoder Shell",
    description: [
      "Execute shell commands in a Recoder sandbox container.",
      "Use for running npm commands, build scripts, or any shell operation.",
      "Commands run in the sandbox's working directory.",
      "Default timeout is 30 seconds; use timeoutMs for longer operations.",
    ].join(" "),
    parameters: Type.Object({
      command: Type.String({
        description: "Shell command to execute",
      }),
      projectId: Type.Optional(
        Type.String({
          description: "Project ID (uses active project if not specified)",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory for the command",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Command timeout in milliseconds (default: 30000)",
        }),
      ),
      env: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Environment variables to set",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const command = readStringParam(params, "command", { required: true });
      const projectId = readStringParam(params, "projectId");
      const cwd = readStringParam(params, "cwd");
      const timeoutMs = readNumberParam(params, "timeoutMs") ?? 30_000;
      const env = params.env as Record<string, string> | undefined;

      // Resolve sandbox
      const targetProjectId = projectId ?? (await getActiveProjectId());
      if (!targetProjectId) {
        throw new Error(
          "No project specified and no active project set. Use recoder_project create first.",
        );
      }

      const project = await getProject(targetProjectId);
      if (!project?.sandboxId) {
        throw new Error(
          `Project ${targetProjectId} has no sandbox. Use recoder_sandbox create first.`,
        );
      }

      const dockerClient = DockerClient.fromConfig(config);

      api.logger.info(`Executing: ${command}`);

      const result = await dockerClient.executeCommand(project.sandboxId, {
        command,
        cwd,
        env,
        timeoutMs,
      });

      // Format output
      let output = "";
      if (result.stdout) {
        output += result.stdout;
      }
      if (result.stderr) {
        output += output ? "\n" : "";
        output += `[stderr] ${result.stderr}`;
      }

      // Truncate very long output
      const maxOutput = 10000;
      const truncated = output.length > maxOutput;
      if (truncated) {
        output = output.slice(0, maxOutput) + "\n... (output truncated)";
      }

      return jsonResult({
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        output: output || "(no output)",
        executionTimeMs: result.executionTimeMs,
        timedOut: result.timedOut,
        truncated,
      });
    },
  };
}
