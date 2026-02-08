/**
 * Recoder Files Tool
 *
 * File CRUD operations in sandbox containers.
 * Actions: read, write, list, delete.
 */

import { Type } from "@sinclair/typebox";

import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { jsonResult, readStringParam } from "../../../../src/agents/tools/common.js";

import type { RecoderPluginConfig } from "../types/index.js";
import { DockerClient } from "../services/docker-client.js";
import {
  getActiveProjectId,
  getProject,
  addCreatedFile,
} from "../services/session-state.js";

export function createRecoderFilesTool(api: OpenClawPluginApi): AnyAgentTool {
  const config = (api.pluginConfig ?? {}) as RecoderPluginConfig;

  return {
    name: "recoder_files",
    label: "Recoder Files",
    description: [
      "Read, write, list, and delete files in a Recoder sandbox.",
      "Actions: read (get file content), write (create/update file), list (directory contents), delete (remove file).",
      "Uses the active project's sandbox if no projectId specified.",
    ].join(" "),
    parameters: Type.Object({
      action: Type.String({
        description: 'Action to perform: "read", "write", "list", or "delete"',
      }),
      path: Type.String({
        description: "File or directory path",
      }),
      projectId: Type.Optional(
        Type.String({
          description: "Project ID (uses active project if not specified)",
        }),
      ),
      content: Type.Optional(
        Type.String({
          description: "File content (required for write action)",
        }),
      ),
      createDirs: Type.Optional(
        Type.Boolean({
          description: "Create parent directories if they don't exist (for write)",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const action = readStringParam(params, "action", { required: true });
      const filePath = readStringParam(params, "path", { required: true });
      const projectId = readStringParam(params, "projectId");
      const content = readStringParam(params, "content");
      const createDirs = params.createDirs !== false;

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
      const sandboxId = project.sandboxId;

      switch (action.toLowerCase()) {
        case "read": {
          const file = await dockerClient.readFile(sandboxId, filePath);

          return jsonResult({
            success: true,
            path: file.path,
            content: file.content,
            size: file.size,
            mimeType: file.mimeType,
            totalLines: file.totalLines,
          });
        }

        case "write": {
          if (content === undefined) {
            throw new Error("content is required for write action");
          }

          await dockerClient.writeFile(sandboxId, {
            path: filePath,
            content,
            createDirectories: createDirs,
          });

          // Track the file
          await addCreatedFile(targetProjectId, filePath);

          return jsonResult({
            success: true,
            path: filePath,
            bytesWritten: content.length,
            message: `File written: ${filePath}`,
          });
        }

        case "list": {
          const { files } = await dockerClient.listFiles(sandboxId, filePath);

          return jsonResult({
            success: true,
            path: filePath,
            files: files.map((f) => ({
              name: f.name,
              path: f.path,
              isDirectory: f.isDirectory,
              size: f.size,
              modifiedAt: f.modifiedAt,
            })),
            count: files.length,
          });
        }

        case "delete": {
          await dockerClient.deleteFile(sandboxId, filePath);

          return jsonResult({
            success: true,
            path: filePath,
            message: `File deleted: ${filePath}`,
          });
        }

        default:
          throw new Error(
            `Unknown action: ${action}. Valid actions: read, write, list, delete`,
          );
      }
    },
  };
}
