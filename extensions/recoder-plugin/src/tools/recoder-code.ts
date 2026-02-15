/**
 * Recoder Code Tool
 *
 * AI code generation via Recoder's /api/chat streaming endpoint.
 * Automatically applies generated code to the project.
 */

import { Type } from "@sinclair/typebox";

import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
import type { AnyAgentTool } from "../../../../src/agents/tools/common.js";
import { jsonResult, readStringParam } from "../../../../src/agents/tools/common.js";

import type { RecoderPluginConfig } from "../types/index.js";
import { RecoderClient } from "../services/recoder-client.js";
import { DockerClient } from "../services/docker-client.js";
import {
  getActiveProjectId,
  getActiveProject,
  addCreatedFile,
  getProject,
} from "../services/session-state.js";

export function createRecoderCodeTool(api: OpenClawPluginApi): AnyAgentTool {
  const config = (api.pluginConfig ?? {}) as RecoderPluginConfig;

  return {
    name: "recoder_code",
    label: "Recoder Code",
    description: [
      "Generate code using AI and apply it to the current Recoder project.",
      "Uses Recoder's AI code generation to create files, components, and full applications.",
      "If no projectId is specified, uses the active project from the session.",
      "Generated files are automatically written to the sandbox and tracked.",
    ].join(" "),
    parameters: Type.Object({
      prompt: Type.String({
        description: "The code generation prompt describing what to build or change",
      }),
      projectId: Type.Optional(
        Type.String({
          description: "Project ID (uses active project if not specified)",
        }),
      ),
      context: Type.Optional(
        Type.String({
          description: "Additional context about existing code or requirements",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "AI model to use (e.g., anthropic/claude-3.5-sonnet)",
        }),
      ),
      provider: Type.Optional(
        Type.String({
          description: "AI provider: openrouter, anthropic, or openai",
        }),
      ),
      applyFiles: Type.Optional(
        Type.Boolean({
          description: "Whether to automatically apply generated files (default: true)",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const prompt = readStringParam(params, "prompt", { required: true });
      const projectId = readStringParam(params, "projectId");
      const context = readStringParam(params, "context");
      const model = readStringParam(params, "model");
      const provider = readStringParam(params, "provider");
      const applyFiles = params.applyFiles !== false;

      // Resolve project
      const targetProjectId = projectId ?? (await getActiveProjectId());
      if (!targetProjectId) {
        throw new Error(
          "No project specified and no active project set. Use recoder_project create first.",
        );
      }

      const project = await getProject(targetProjectId);
      if (!project) {
        throw new Error(
          `Project not found: ${targetProjectId}. Use recoder_project create first.`,
        );
      }

      const recoderClient = RecoderClient.fromConfig(config);
      const dockerClient = DockerClient.fromConfig(config);

      // Build context from project files if not provided
      let codeContext = context ?? "";
      if (!codeContext && project.createdFiles.length > 0 && project.sandboxId) {
        try {
          // Load up to 5 most recent files for context
          const filesToLoad = project.createdFiles.slice(-5);
          const fileContents: string[] = [];

          for (const filePath of filesToLoad) {
            try {
              const file = await dockerClient.readFile(project.sandboxId, filePath);
              fileContents.push(`=== ${filePath} ===\n${file.content}`);
            } catch {
              // File may not exist
            }
          }

          if (fileContents.length > 0) {
            codeContext = `EXISTING PROJECT FILES:\n${fileContents.join("\n\n")}`;
          }
        } catch {
          // Non-critical
        }
      }

      // Generate code
      api.logger.info(`Generating code for project ${targetProjectId}...`);

      const response = await recoderClient.generateCode({
        projectId: targetProjectId,
        prompt,
        context: codeContext,
        model,
        provider,
      });

      if (!response.success) {
        return jsonResult({
          success: false,
          error: response.error ?? "Code generation failed",
          message: response.message,
        });
      }

      const files = response.files ?? [];
      const appliedFiles: string[] = [];
      const failedFiles: Array<{ path: string; error: string }> = [];

      // Apply files to sandbox
      if (applyFiles && files.length > 0 && project.sandboxId) {
        api.logger.info(`Applying ${files.length} files to sandbox...`);

        for (const file of files) {
          try {
            await dockerClient.writeFile(project.sandboxId, {
              path: file.path,
              content: file.content,
              createDirectories: true,
            });
            appliedFiles.push(file.path);
            await addCreatedFile(targetProjectId, file.path);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            failedFiles.push({ path: file.path, error: errMsg });
          }
        }

        // Run npm install if package.json was created/updated
        const hasPackageJson = files.some((f) => f.path === "package.json");
        if (hasPackageJson) {
          try {
            api.logger.info("Running npm install...");
            await dockerClient.shell(project.sandboxId, "npm install", {
              timeoutMs: 120_000,
            });
          } catch {
            // Non-critical
          }
        }
      }

      // Get preview URL
      const previewUrl = project.previewUrl ?? dockerClient.getPreviewUrl(project.sandboxId!);

      return jsonResult({
        success: true,
        projectId: targetProjectId,
        filesGenerated: files.length,
        filesApplied: appliedFiles.length,
        filesFailed: failedFiles.length,
        appliedFiles,
        failedFiles: failedFiles.length > 0 ? failedFiles : undefined,
        previewUrl,
        message:
          files.length > 0
            ? `Generated ${files.length} files. ${appliedFiles.length} applied successfully. Preview: ${previewUrl}`
            : "Code generation completed but no files were created.",
      });
    },
  };
}
