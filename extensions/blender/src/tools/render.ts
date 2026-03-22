import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam, optionalStringEnum } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { runBlenderBackground, buildBackgroundRenderScript } from "../background.js";
import { createBlenderClient, resolveBlenderConfig } from "../client.js";

const RenderSchema = Type.Object({
  outputPath: Type.String({
    description:
      "File path for the render output. For animations use a directory path or token like //renders/frame_. " +
      "Format is inferred from extension: .png, .jpg, .exr, .mp4.",
  }),
  mode: optionalStringEnum(["live", "background"] as const, {
    description:
      "'live' renders in the open Blender session (default). 'background' spawns a headless process.",
  }),
  blendFile: Type.Optional(
    Type.String({
      description:
        "Path to a .blend file to open (required in background mode without open session).",
    }),
  ),
  frameStart: Type.Optional(Type.Number({ description: "Start frame for animation render." })),
  frameEnd: Type.Optional(
    Type.Number({ description: "End frame for animation render. Omit for a single still." }),
  ),
  engine: optionalStringEnum(["CYCLES", "BLENDER_EEVEE_NEXT"] as const, {
    description: "Render engine override.",
  }),
  resolutionX: Type.Optional(Type.Number({ minimum: 1 })),
  resolutionY: Type.Optional(Type.Number({ minimum: 1 })),
  samples: Type.Optional(Type.Number({ minimum: 1 })),
  camera: Type.Optional(Type.String({ description: "Name of the camera object to render from." })),
});

const BatchRenderSchema = Type.Object({
  blendFile: Type.String({ description: "Path to the .blend file to open." }),
  jobs: Type.Array(
    Type.Object({
      outputPath: Type.String({ description: "Output path for this render job." }),
      camera: Type.Optional(Type.String({ description: "Camera name for this job." })),
      frameStart: Type.Optional(Type.Number()),
      frameEnd: Type.Optional(Type.Number()),
      engine: Type.Optional(Type.String()),
      resolutionX: Type.Optional(Type.Number()),
      resolutionY: Type.Optional(Type.Number()),
      samples: Type.Optional(Type.Number()),
    }),
    { description: "List of render jobs to execute sequentially." },
  ),
});

const ScreenshotSchema = Type.Object({
  outputPath: Type.String({ description: "File path to save the viewport screenshot (.png)." }),
  width: Type.Optional(Type.Number({ description: "Viewport width in pixels.", minimum: 1 })),
  height: Type.Optional(Type.Number({ description: "Viewport height in pixels.", minimum: 1 })),
});

export function createRenderTool(api: OpenClawPluginApi) {
  return {
    name: "blender_render",
    label: "Blender: Render",
    description:
      "Render the current scene (still frame or animation) using Cycles or EEVEE. " +
      "Supports both live (interactive session) and background (headless) modes. " +
      "Returns the output file path when complete.",
    parameters: RenderSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const outputPath = readStringParam(rawParams, "outputPath", { required: true });
      const mode = (readStringParam(rawParams, "mode") ?? "live") as "live" | "background";
      const blendFile = readStringParam(rawParams, "blendFile");
      const frameStart = rawParams["frameStart"] as number | undefined;
      const frameEnd = rawParams["frameEnd"] as number | undefined;
      const engine = readStringParam(rawParams, "engine");
      const resolutionX = rawParams["resolutionX"] as number | undefined;
      const resolutionY = rawParams["resolutionY"] as number | undefined;
      const samples = rawParams["samples"] as number | undefined;
      const camera = readStringParam(rawParams, "camera");

      const cfg = resolveBlenderConfig(api.pluginConfig);
      const isAnimation = frameStart !== undefined && frameEnd !== undefined;

      if (mode === "background") {
        const pythonCode = buildBackgroundRenderScript({
          outputPath: outputPath!,
          frameStart,
          frameEnd,
          engine: engine ?? undefined,
          resolutionX,
          resolutionY,
          samples,
          camera: camera ?? undefined,
        });
        const result = await runBlenderBackground({
          blenderExecutable: cfg.executablePath,
          blendFile: blendFile ?? undefined,
          pythonCode,
          timeoutMs: 600_000,
        });
        if (!result.ok) {
          return jsonResult(`Render failed.\n${result.stderr || result.stdout}`.trim());
        }
        return jsonResult(
          `Render complete. Output: ${outputPath}${isAnimation ? ` (frames ${frameStart}-${frameEnd})` : ""}`,
        );
      }

      const client = createBlenderClient({ host: cfg.host, port: cfg.port, timeoutMs: 600_000 });
      const status = await client.status();
      if (!status.running) {
        return jsonResult(
          "Blender bridge is not running. Open Blender, enable the OpenClaw Bridge addon, or use mode='background'.",
        );
      }

      const result = await client.render({
        outputPath: outputPath!,
        frameStart,
        frameEnd,
        engine: engine ?? undefined,
        resolutionX,
        resolutionY,
        samples,
        camera: camera ?? undefined,
      });

      if (!result.ok) return jsonResult(`Render failed: ${result.error}`);
      return jsonResult(
        `Render complete. Output: ${result.outputPath ?? outputPath}` +
          (result.framesRendered ? ` (${result.framesRendered} frames)` : ""),
      );
    },
  };
}

export function createBatchRenderTool(api: OpenClawPluginApi) {
  return {
    name: "blender_batch_render",
    label: "Blender: Batch Render",
    description:
      "Run multiple render jobs from a single .blend file in background mode — useful for rendering " +
      "the same scene from multiple cameras, multiple frame ranges, or with different engine settings.",
    parameters: BatchRenderSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const blendFile = readStringParam(rawParams, "blendFile", { required: true });
      const jobs = rawParams["jobs"] as Array<Record<string, unknown>>;

      if (!Array.isArray(jobs) || jobs.length === 0) {
        return jsonResult("No jobs provided.");
      }

      const cfg = resolveBlenderConfig(api.pluginConfig);
      const results: string[] = [];

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]!;
        const outputPath = job["outputPath"] as string;
        const pythonCode = buildBackgroundRenderScript({
          outputPath,
          frameStart: job["frameStart"] as number | undefined,
          frameEnd: job["frameEnd"] as number | undefined,
          engine: job["engine"] as string | undefined,
          resolutionX: job["resolutionX"] as number | undefined,
          resolutionY: job["resolutionY"] as number | undefined,
          samples: job["samples"] as number | undefined,
          camera: job["camera"] as string | undefined,
        });

        const result = await runBlenderBackground({
          blenderExecutable: cfg.executablePath,
          blendFile: blendFile!,
          pythonCode,
          timeoutMs: 600_000,
        });

        results.push(
          `Job ${i + 1}/${jobs.length} -> ${outputPath}: ${result.ok ? "OK" : `FAILED\n${result.stderr.slice(0, 500)}`}`,
        );
      }

      return jsonResult(results.join("\n"));
    },
  };
}

export function createScreenshotTool(api: OpenClawPluginApi) {
  return {
    name: "blender_viewport_screenshot",
    label: "Blender: Viewport Screenshot",
    description:
      "Capture the current Blender 3D viewport as a PNG image. " +
      "Useful for quickly previewing scene state without a full render.",
    parameters: ScreenshotSchema,

    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const outputPath = readStringParam(rawParams, "outputPath", { required: true });
      const width = rawParams["width"] as number | undefined;
      const height = rawParams["height"] as number | undefined;
      const cfg = resolveBlenderConfig(api.pluginConfig);
      const client = createBlenderClient({ host: cfg.host, port: cfg.port });

      const status = await client.status();
      if (!status.running) {
        return jsonResult(
          "Blender bridge is not running. Viewport screenshot requires a live Blender session.",
        );
      }

      const result = await client.screenshot({ outputPath: outputPath!, width, height });
      if (!result.ok) return jsonResult(`Screenshot failed: ${result.error}`);
      return jsonResult(`Screenshot saved to: ${outputPath}`);
    },
  };
}
