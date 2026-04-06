import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { runComfyWorkflow } from "./workflow-runtime.js";

function readStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function createComfyMusicGenerateTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "music_generate",
    label: "music_generate",
    description: "Generate audio or music with a workflow-configured ComfyUI graph.",
    parameters: Type.Object({
      action: Type.Optional(Type.String({ default: "generate", enum: ["generate", "list"] })),
      prompt: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      filename: Type.Optional(Type.String()),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const action = readStringParam(params, "action") ?? "generate";
      if (action === "list") {
        const text = ["Available music generation providers:", "- comfy/workflow"].join("\n");
        return {
          content: [{ type: "text", text }],
          details: {
            providers: [
              {
                provider: "comfy",
                models: ["workflow"],
              },
            ],
          },
        };
      }

      const prompt = readStringParam(params, "prompt");
      if (!prompt) {
        throw new Error("prompt required");
      }

      const result = await runComfyWorkflow({
        cfg: api.config,
        prompt,
        capability: "music",
        model: readStringParam(params, "model"),
        outputKinds: ["audio"],
      });
      const filenameHint = readStringParam(params, "filename");
      const saved = await Promise.all(
        result.assets.map((asset) =>
          api.runtime.channel.media.saveMediaBuffer(
            asset.buffer,
            asset.mimeType,
            "tool-music-generation",
            undefined,
            filenameHint || asset.fileName,
          ),
        ),
      );

      const lines = [
        `Generated ${saved.length} audio file${saved.length === 1 ? "" : "s"} with comfy/${result.model}.`,
        ...saved.map((entry) => `MEDIA:${entry.path}`),
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          provider: "comfy",
          model: result.model,
          count: saved.length,
          media: {
            mediaUrls: saved.map((entry) => entry.path),
          },
          paths: saved.map((entry) => entry.path),
          metadata: {
            promptId: result.promptId,
            outputNodeIds: result.outputNodeIds,
          },
        },
      };
    },
  };
}
