/**
 * Recoder Sandbox Tool
 *
 * Manage Docker containers for code execution.
 * Actions: create, status, restart, stop.
 */

import { Type } from "@sinclair/typebox";

import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { jsonResult, readStringParam } from "../../../../src/agents/tools/common.js";

import type { RecoderPluginConfig, SandboxTemplate } from "../types/index.js";
import { DockerClient } from "../services/docker-client.js";
import {
  getActiveProjectId,
  getProject,
  updateProjectSandbox,
} from "../services/session-state.js";

export function createRecoderSandboxTool(api: OpenClawPluginApi): AnyAgentTool {
  const config = (api.pluginConfig ?? {}) as RecoderPluginConfig;

  return {
    name: "recoder_sandbox",
    label: "Recoder Sandbox",
    description: [
      "Manage Docker sandbox containers for code execution.",
      "Actions: create (new container), status (check state), restart, stop.",
      "Sandboxes provide isolated environments for running generated code.",
      "Use after recoder_project to start a development environment.",
    ].join(" "),
    parameters: Type.Object({
      action: Type.String({
        description: 'Action to perform: "create", "status", "restart", or "stop"',
      }),
      projectId: Type.Optional(
        Type.String({
          description: "Project ID (uses active project if not specified)",
        }),
      ),
      sandboxId: Type.Optional(
        Type.String({
          description: "Sandbox ID (for direct sandbox operations)",
        }),
      ),
      template: Type.Optional(
        Type.String({
          description:
            'Template for new sandbox: "react", "nextjs", "vue", "svelte", "node", "python", "vanilla"',
        }),
      ),
      startDevServer: Type.Optional(
        Type.Boolean({
          description: "Whether to start dev server on creation (default: true)",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const action = readStringParam(params, "action", { required: true });
      const projectId = readStringParam(params, "projectId");
      const sandboxId = readStringParam(params, "sandboxId");
      const template = readStringParam(params, "template") as SandboxTemplate | undefined;
      const startDevServer = params.startDevServer !== false;

      const dockerClient = DockerClient.fromConfig(config);

      // Resolve sandbox ID from project if not provided
      let targetSandboxId = sandboxId;
      let targetProjectId = projectId;

      if (!targetSandboxId) {
        targetProjectId = projectId ?? (await getActiveProjectId());
        if (targetProjectId) {
          const project = await getProject(targetProjectId);
          targetSandboxId = project?.sandboxId;
        }
      }

      switch (action.toLowerCase()) {
        case "create": {
          const name = targetProjectId ?? `sandbox-${Date.now()}`;

          const sandbox = await dockerClient.createSandbox({
            name,
            template: template ?? config.defaultTemplate ?? "react",
            startDevServer: startDevServer ?? config.autoStartSandbox ?? true,
            timeoutSeconds: config.sandboxTimeoutSeconds,
          });

          // Update project state if we have a project
          if (targetProjectId) {
            await updateProjectSandbox(
              targetProjectId,
              sandbox.id,
              sandbox.previewUrl ?? dockerClient.getPreviewUrl(sandbox.id),
            );
          }

          return jsonResult({
            success: true,
            sandbox: {
              id: sandbox.id,
              name: sandbox.name,
              state: sandbox.state,
              template: sandbox.template,
              previewUrl: sandbox.previewUrl ?? dockerClient.getPreviewUrl(sandbox.id),
              createdAt: sandbox.createdAt,
            },
            message: `Sandbox created. Preview: ${sandbox.previewUrl ?? dockerClient.getPreviewUrl(sandbox.id)}`,
          });
        }

        case "status": {
          if (!targetSandboxId) {
            // List all sandboxes if no specific one
            const { sandboxes } = await dockerClient.listSandboxes();
            return jsonResult({
              success: true,
              sandboxes: sandboxes.map((s) => ({
                id: s.id,
                name: s.name,
                state: s.state,
                template: s.template,
                previewUrl: s.previewUrl,
              })),
              count: sandboxes.length,
            });
          }

          const sandbox = await dockerClient.getSandbox(targetSandboxId);

          // Also get dev server status
          let devServer;
          try {
            devServer = await dockerClient.getDevServerStatus(targetSandboxId);
          } catch {
            // Dev server may not be available
          }

          return jsonResult({
            success: true,
            sandbox: {
              id: sandbox.id,
              name: sandbox.name,
              state: sandbox.state,
              template: sandbox.template,
              previewUrl: sandbox.previewUrl ?? dockerClient.getPreviewUrl(sandbox.id),
              createdAt: sandbox.createdAt,
              lastActivityAt: sandbox.lastActivityAt,
              expiresAt: sandbox.expiresAt,
            },
            devServer,
          });
        }

        case "restart": {
          if (!targetSandboxId) {
            throw new Error("No sandbox specified and no active project with sandbox");
          }

          const sandbox = await dockerClient.restartSandbox(targetSandboxId);

          // Restart dev server
          let devServer;
          try {
            devServer = await dockerClient.startDevServer(targetSandboxId);
          } catch {
            // Dev server start may fail
          }

          return jsonResult({
            success: true,
            sandbox: {
              id: sandbox.id,
              state: sandbox.state,
              previewUrl: devServer?.previewUrl ?? sandbox.previewUrl,
            },
            message: "Sandbox restarted successfully",
          });
        }

        case "stop": {
          if (!targetSandboxId) {
            throw new Error("No sandbox specified and no active project with sandbox");
          }

          const sandbox = await dockerClient.stopSandbox(targetSandboxId);

          return jsonResult({
            success: true,
            sandbox: {
              id: sandbox.id,
              state: sandbox.state,
            },
            message: "Sandbox stopped successfully",
          });
        }

        case "start": {
          if (!targetSandboxId) {
            throw new Error("No sandbox specified and no active project with sandbox");
          }

          const sandbox = await dockerClient.startSandbox(targetSandboxId);

          // Start dev server
          let devServer;
          try {
            devServer = await dockerClient.startDevServer(targetSandboxId);
          } catch {
            // Dev server start may fail
          }

          return jsonResult({
            success: true,
            sandbox: {
              id: sandbox.id,
              state: sandbox.state,
              previewUrl: devServer?.previewUrl ?? sandbox.previewUrl,
            },
            message: "Sandbox started successfully",
          });
        }

        default:
          throw new Error(
            `Unknown action: ${action}. Valid actions: create, status, restart, stop, start`,
          );
      }
    },
  };
}
