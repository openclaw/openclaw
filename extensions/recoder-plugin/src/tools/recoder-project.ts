/**
 * Recoder Project Tool
 *
 * Manage Recoder projects: create, list, get, delete.
 */

import { Type } from "@sinclair/typebox";

import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { jsonResult, readStringParam } from "../../../../src/agents/tools/common.js";

import type { RecoderPluginConfig, SandboxTemplate } from "../types/index.js";
import { RecoderClient } from "../services/recoder-client.js";
import { DockerClient } from "../services/docker-client.js";
import {
  getActiveProjectId,
  setActiveProjectId,
  upsertProject,
  removeProject,
  listProjects as listSessionProjects,
  getProject,
} from "../services/session-state.js";

export function createRecoderProjectTool(api: OpenClawPluginApi): AnyAgentTool {
  const config = (api.pluginConfig ?? {}) as RecoderPluginConfig;

  return {
    name: "recoder_project",
    label: "Recoder Project",
    description: [
      "Manage Recoder projects for code generation and deployment.",
      "Actions: create (new project), list (all projects), get (project details), delete (remove project).",
      "Templates: react, nextjs, vue, svelte, node, python, vanilla.",
      "After creating a project, use recoder_sandbox to start a container, then recoder_code to generate code.",
    ].join(" "),
    parameters: Type.Object({
      action: Type.String({
        description: 'Action to perform: "create", "list", "get", or "delete"',
      }),
      name: Type.Optional(
        Type.String({
          description: "Project name (required for create)",
        }),
      ),
      projectId: Type.Optional(
        Type.String({
          description: "Project ID (required for get/delete, optional for others)",
        }),
      ),
      template: Type.Optional(
        Type.String({
          description:
            'Project template: "react", "nextjs", "vue", "svelte", "node", "python", "vanilla"',
        }),
      ),
      setActive: Type.Optional(
        Type.Boolean({
          description: "Set this project as active for subsequent operations (default: true)",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const action = readStringParam(params, "action", { required: true });
      const name = readStringParam(params, "name");
      const projectId = readStringParam(params, "projectId");
      const template = readStringParam(params, "template") as SandboxTemplate | undefined;
      const setActive = params.setActive !== false;

      const recoderClient = RecoderClient.fromConfig(config);
      const dockerClient = DockerClient.fromConfig(config);

      switch (action.toLowerCase()) {
        case "create": {
          if (!name) {
            throw new Error("name is required for create action");
          }

          // Create sandbox first
          const sandbox = await dockerClient.createSandbox({
            name,
            template: template ?? config.defaultTemplate ?? "react",
            startDevServer: config.autoStartSandbox ?? true,
            timeoutSeconds: config.sandboxTimeoutSeconds,
          });

          // Track in session state
          const project = {
            id: sandbox.id,
            name,
            sandboxId: sandbox.id,
            previewUrl: sandbox.previewUrl ?? dockerClient.getPreviewUrl(sandbox.id),
            createdFiles: [],
            lastActivityAt: Date.now(),
          };

          await upsertProject(project);

          if (setActive) {
            await setActiveProjectId(sandbox.id);
          }

          return jsonResult({
            success: true,
            project: {
              id: sandbox.id,
              name,
              template: sandbox.template,
              state: sandbox.state,
              previewUrl: project.previewUrl,
              createdAt: sandbox.createdAt,
            },
            message: `Project "${name}" created successfully. Preview URL: ${project.previewUrl}`,
          });
        }

        case "list": {
          // Get from session state
          const sessionProjects = await listSessionProjects();
          const activeId = await getActiveProjectId();

          return jsonResult({
            success: true,
            projects: sessionProjects.map((p) => ({
              id: p.id,
              name: p.name,
              sandboxId: p.sandboxId,
              previewUrl: p.previewUrl,
              isActive: p.id === activeId,
              filesCreated: p.createdFiles.length,
              lastActivity: p.lastActivityAt,
            })),
            activeProjectId: activeId,
            count: sessionProjects.length,
          });
        }

        case "get": {
          // Use provided projectId or active project
          const targetId = projectId ?? (await getActiveProjectId());
          if (!targetId) {
            throw new Error("No project specified and no active project set");
          }

          const sessionProject = await getProject(targetId);
          if (!sessionProject) {
            throw new Error(`Project not found: ${targetId}`);
          }

          // Get sandbox status
          let sandboxStatus;
          try {
            if (sessionProject.sandboxId) {
              sandboxStatus = await dockerClient.getSandbox(sessionProject.sandboxId);
            }
          } catch {
            // Sandbox may not exist anymore
          }

          return jsonResult({
            success: true,
            project: {
              id: sessionProject.id,
              name: sessionProject.name,
              sandboxId: sessionProject.sandboxId,
              previewUrl: sessionProject.previewUrl,
              createdFiles: sessionProject.createdFiles,
              lastActivity: sessionProject.lastActivityAt,
              sandbox: sandboxStatus
                ? {
                    state: sandboxStatus.state,
                    template: sandboxStatus.template,
                    previewUrl: sandboxStatus.previewUrl,
                  }
                : undefined,
            },
          });
        }

        case "delete": {
          const targetId = projectId ?? (await getActiveProjectId());
          if (!targetId) {
            throw new Error("No project specified and no active project set");
          }

          const sessionProject = await getProject(targetId);

          // Delete sandbox if exists
          if (sessionProject?.sandboxId) {
            try {
              await dockerClient.deleteSandbox(sessionProject.sandboxId);
            } catch {
              // Sandbox may already be deleted
            }
          }

          // Remove from session state
          await removeProject(targetId);

          return jsonResult({
            success: true,
            message: `Project ${targetId} deleted successfully`,
            deletedId: targetId,
          });
        }

        default:
          throw new Error(
            `Unknown action: ${action}. Valid actions: create, list, get, delete`,
          );
      }
    },
  };
}
