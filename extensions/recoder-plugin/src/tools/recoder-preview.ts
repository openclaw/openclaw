/**
 * Recoder Preview Tool
 *
 * Get preview URL for running projects.
 */

import { Type } from "@sinclair/typebox";

import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { jsonResult, readStringParam } from "../../../../src/agents/tools/common.js";

import type { RecoderPluginConfig } from "../types/index.js";
import { DockerClient } from "../services/docker-client.js";
import { getActiveProjectId, getProject, listProjects } from "../services/session-state.js";

export function createRecoderPreviewTool(api: OpenClawPluginApi): AnyAgentTool {
  const config = (api.pluginConfig ?? {}) as RecoderPluginConfig;

  return {
    name: "recoder_preview",
    label: "Recoder Preview",
    description: [
      "Get the preview URL for a running Recoder project.",
      "Returns the live preview URL where the app can be viewed.",
      "Can also start/restart the dev server if needed.",
    ].join(" "),
    parameters: Type.Object({
      projectId: Type.Optional(
        Type.String({
          description: "Project ID (uses active project if not specified)",
        }),
      ),
      action: Type.Optional(
        Type.String({
          description: 'Optional action: "get" (default), "start", "stop", or "restart"',
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const projectId = readStringParam(params, "projectId");
      const action = readStringParam(params, "action") ?? "get";

      const dockerClient = DockerClient.fromConfig(config);

      // If no project specified and action is "get", return all preview URLs
      if (!projectId && action === "get") {
        const targetProjectId = await getActiveProjectId();

        if (!targetProjectId) {
          // Return all projects with preview URLs
          const projects = await listProjects();
          const previews = projects
            .filter((p) => p.sandboxId)
            .map((p) => ({
              projectId: p.id,
              name: p.name,
              previewUrl: p.previewUrl ?? dockerClient.getPreviewUrl(p.sandboxId!),
            }));

          return jsonResult({
            success: true,
            previews,
            count: previews.length,
            message:
              previews.length > 0
                ? `Found ${previews.length} projects with preview URLs`
                : "No projects with sandboxes found",
          });
        }

        // Get preview for active project
        const project = await getProject(targetProjectId);
        if (!project?.sandboxId) {
          throw new Error("Active project has no sandbox");
        }

        const previewUrl =
          project.previewUrl ?? dockerClient.getPreviewUrl(project.sandboxId);

        // Check dev server status
        let devServer;
        try {
          devServer = await dockerClient.getDevServerStatus(project.sandboxId);
        } catch {
          // Dev server status check may fail
        }

        return jsonResult({
          success: true,
          projectId: targetProjectId,
          name: project.name,
          previewUrl,
          devServerRunning: devServer?.running ?? false,
        });
      }

      // Resolve specific project
      const targetProjectId = projectId ?? (await getActiveProjectId());
      if (!targetProjectId) {
        throw new Error("No project specified and no active project set");
      }

      const project = await getProject(targetProjectId);
      if (!project?.sandboxId) {
        throw new Error(`Project ${targetProjectId} has no sandbox`);
      }

      const sandboxId = project.sandboxId;

      switch (action.toLowerCase()) {
        case "get": {
          const previewUrl =
            project.previewUrl ?? dockerClient.getPreviewUrl(sandboxId);

          let devServer;
          try {
            devServer = await dockerClient.getDevServerStatus(sandboxId);
          } catch {
            // Dev server status check may fail
          }

          return jsonResult({
            success: true,
            projectId: targetProjectId,
            name: project.name,
            previewUrl: devServer?.previewUrl ?? previewUrl,
            devServerRunning: devServer?.running ?? false,
            port: devServer?.port,
          });
        }

        case "start": {
          const devServer = await dockerClient.startDevServer(sandboxId);

          return jsonResult({
            success: true,
            projectId: targetProjectId,
            previewUrl: devServer.previewUrl,
            message: "Dev server started",
          });
        }

        case "stop": {
          await dockerClient.stopDevServer(sandboxId);

          return jsonResult({
            success: true,
            projectId: targetProjectId,
            message: "Dev server stopped",
          });
        }

        case "restart": {
          // Stop then start
          try {
            await dockerClient.stopDevServer(sandboxId);
          } catch {
            // May already be stopped
          }

          const devServer = await dockerClient.startDevServer(sandboxId);

          return jsonResult({
            success: true,
            projectId: targetProjectId,
            previewUrl: devServer.previewUrl,
            message: "Dev server restarted",
          });
        }

        default:
          throw new Error(
            `Unknown action: ${action}. Valid actions: get, start, stop, restart`,
          );
      }
    },
  };
}
