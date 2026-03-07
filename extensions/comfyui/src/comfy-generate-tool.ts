import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "../../../src/plugins/types.js";
import { requestComfyGenerateSync } from "./client.js";
import { isPathUnderRoots, resolveComfyPluginConfig } from "./config.js";
import type {
  ComfyControlInput,
  ComfyGenerateMode,
  ComfyGenerateRequest,
  ComfyIpAdapterInput,
  ComfyLoraInput,
} from "./types.js";

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readString(
  value: unknown,
  label: string,
  options: { required?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new Error(`${label} required`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed && options.required) {
    throw new Error(`${label} required`);
  }
  return trimmed || undefined;
}

function readNumber(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; integer?: boolean; required?: boolean } = {},
): number | undefined {
  if (value === undefined || value === null) {
    if (options.required) {
      throw new Error(`${label} required`);
    }
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  const normalized = options.integer ? Math.trunc(value) : value;
  if (typeof options.min === "number" && normalized < options.min) {
    throw new Error(`${label} must be >= ${options.min}`);
  }
  if (typeof options.max === "number" && normalized > options.max) {
    throw new Error(`${label} must be <= ${options.max}`);
  }
  return normalized;
}

function readMode(value: unknown): ComfyGenerateMode {
  const mode = readString(value, "mode") ?? "txt2img";
  if (mode !== "txt2img" && mode !== "img2img") {
    throw new Error("mode must be txt2img or img2img");
  }
  return mode;
}

function fieldValue(
  record: Record<string, unknown>,
  keys: string[],
  options: { required?: boolean; label: string },
): string | undefined {
  for (const key of keys) {
    const value = readString(record[key], options.label, {
      required: false,
    });
    if (value) {
      return value;
    }
  }
  if (options.required) {
    throw new Error(`${options.label} required`);
  }
  return undefined;
}

async function validateAbsolutePath(
  value: string | undefined,
  label: string,
  roots: string[],
): Promise<string | undefined> {
  if (!value) {
    return undefined;
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const resolved = path.resolve(value);
  if (!isPathUnderRoots(resolved, roots)) {
    throw new Error(`${label} is outside allowedPathRoots`);
  }
  await fs.access(resolved);
  return resolved;
}

async function parseControls(
  value: unknown,
  allowedRoots: string[],
  maxControls: number,
): Promise<ComfyControlInput[] | undefined> {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("control must be an array");
  }
  if (value.length > maxControls) {
    throw new Error(`control supports up to ${maxControls} entries`);
  }
  const controls: ComfyControlInput[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = asRecord(value[i], `control[${i}]`);
    const type = fieldValue(entry, ["type"], { required: true, label: `control[${i}].type` });
    const imagePath = fieldValue(entry, ["imagePath", "image_path"], {
      required: true,
      label: `control[${i}].imagePath`,
    });
    const checkedImagePath = await validateAbsolutePath(
      imagePath,
      `control[${i}].imagePath`,
      allowedRoots,
    );
    controls.push({
      type: type ?? "",
      image_path: checkedImagePath ?? "",
      strength: readNumber(entry.strength, `control[${i}].strength`, { min: 0, max: 2 }),
      start: readNumber(entry.start, `control[${i}].start`, { min: 0, max: 1 }),
      end: readNumber(entry.end, `control[${i}].end`, { min: 0, max: 1 }),
    });
  }
  return controls;
}

async function parseIpAdapter(
  value: unknown,
  allowedRoots: string[],
): Promise<ComfyIpAdapterInput | undefined> {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = asRecord(value, "ipAdapter");
  const imagePath = fieldValue(record, ["imagePath", "image_path"], {
    required: true,
    label: "ipAdapter.imagePath",
  });
  const checkedImagePath = await validateAbsolutePath(
    imagePath,
    "ipAdapter.imagePath",
    allowedRoots,
  );
  return {
    image_path: checkedImagePath ?? "",
    weight: readNumber(record.weight, "ipAdapter.weight", { min: 0, max: 2 }),
  };
}

function parseLoras(value: unknown, maxLoras: number): ComfyLoraInput[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("loras must be an array");
  }
  if (value.length > maxLoras) {
    throw new Error(`loras supports up to ${maxLoras} entries`);
  }
  const loras: ComfyLoraInput[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = asRecord(value[i], `loras[${i}]`);
    const name = fieldValue(entry, ["name"], { required: true, label: `loras[${i}].name` });
    loras.push({
      name: name ?? "",
      scale: readNumber(entry.scale, `loras[${i}].scale`, { min: 0, max: 2 }),
    });
  }
  return loras;
}

function assertAllowedModel(model: string | undefined, allowlist: string[]): void {
  if (!model || allowlist.length === 0) {
    return;
  }
  if (!allowlist.includes(model)) {
    throw new Error(`model not allowed: ${model}`);
  }
}

function assertAllowedStrings(values: string[], allowlist: string[], label: string): void {
  if (allowlist.length === 0) {
    return;
  }
  for (const value of values) {
    if (!allowlist.includes(value)) {
      throw new Error(`${label} not allowed: ${value}`);
    }
  }
}

async function assertOutputPath(
  imagePath: string,
  allowedOutputDir: string | undefined,
): Promise<string> {
  if (!path.isAbsolute(imagePath)) {
    throw new Error("bridge returned non-absolute image_path");
  }
  const resolved = path.resolve(imagePath);
  if (allowedOutputDir && !isPathUnderRoots(resolved, [allowedOutputDir])) {
    throw new Error("bridge returned image_path outside configured outputDir");
  }
  await fs.access(resolved);
  return resolved;
}

export function createComfyGenerateTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "comfy_generate",
    label: "Comfy Generate",
    description: "Generate local images through a loopback ComfyUI bridge.",
    parameters: Type.Object({
      mode: Type.Optional(
        Type.Unsafe<ComfyGenerateMode>({ type: "string", enum: ["txt2img", "img2img"] }),
      ),
      prompt: Type.String({ description: "Main positive prompt text." }),
      negativePrompt: Type.Optional(Type.String({ description: "Optional negative prompt text." })),
      width: Type.Optional(Type.Number({ description: "Image width in pixels." })),
      height: Type.Optional(Type.Number({ description: "Image height in pixels." })),
      steps: Type.Optional(Type.Number({ description: "Sampling steps." })),
      guidance: Type.Optional(Type.Number({ description: "Guidance scale / CFG." })),
      seed: Type.Optional(Type.Number({ description: "Seed value. Omit for random." })),
      model: Type.Optional(
        Type.String({ description: "Model override (must be allowlisted if configured)." }),
      ),
      initImagePath: Type.Optional(
        Type.String({ description: "Absolute init image path for img2img." }),
      ),
      denoise: Type.Optional(Type.Number({ description: "Denoise strength for img2img." })),
      control: Type.Optional(
        Type.Array(
          Type.Object({
            type: Type.String(),
            imagePath: Type.String(),
            strength: Type.Optional(Type.Number()),
            start: Type.Optional(Type.Number()),
            end: Type.Optional(Type.Number()),
          }),
        ),
      ),
      ipAdapter: Type.Optional(
        Type.Object({
          imagePath: Type.String(),
          weight: Type.Optional(Type.Number()),
        }),
      ),
      loras: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String(),
            scale: Type.Optional(Type.Number()),
          }),
        ),
      ),
      workflowPath: Type.Optional(
        Type.String({
          description:
            "Absolute path to a ComfyUI API workflow JSON file. Required for control/IPAdapter/LoRA stack.",
        }),
      ),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-call timeout in milliseconds." })),
    }),

    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const cfg = resolveComfyPluginConfig(api.pluginConfig);
      const mode = readMode(rawParams.mode);
      const prompt = readString(rawParams.prompt, "prompt", { required: true }) ?? "";
      const negativePrompt = readString(rawParams.negativePrompt, "negativePrompt");
      const width = readNumber(rawParams.width, "width", {
        min: 64,
        max: cfg.maxWidth,
        integer: true,
      });
      const height = readNumber(rawParams.height, "height", {
        min: 64,
        max: cfg.maxHeight,
        integer: true,
      });
      const steps = readNumber(rawParams.steps, "steps", { min: 1, max: 200, integer: true });
      const guidance = readNumber(rawParams.guidance, "guidance", { min: 0, max: 30 });
      const seed = readNumber(rawParams.seed, "seed", { integer: true });
      const denoise = readNumber(rawParams.denoise, "denoise", { min: 0, max: 1 });
      const model = readString(rawParams.model, "model") ?? cfg.defaultModel;
      const timeoutMs =
        readNumber(rawParams.timeoutMs, "timeoutMs", { min: 1000, max: 600_000, integer: true }) ??
        cfg.timeoutMs;
      const workflowPathRaw = readString(rawParams.workflowPath, "workflowPath");

      assertAllowedModel(model, cfg.allowedModels);

      const workflowPath = await validateAbsolutePath(
        workflowPathRaw,
        "workflowPath",
        cfg.allowedPathRoots,
      );
      const initImagePath = await validateAbsolutePath(
        readString(rawParams.initImagePath, "initImagePath"),
        "initImagePath",
        cfg.allowedPathRoots,
      );

      if (mode === "img2img" && !initImagePath) {
        throw new Error("initImagePath required when mode is img2img");
      }

      const control = await parseControls(rawParams.control, cfg.allowedPathRoots, cfg.maxControls);
      const ipAdapter = await parseIpAdapter(rawParams.ipAdapter, cfg.allowedPathRoots);
      const loras = parseLoras(rawParams.loras, cfg.maxLoras);
      assertAllowedStrings(
        (control ?? []).map((entry) => entry.type),
        cfg.allowedControlTypes,
        "control type",
      );
      assertAllowedStrings(
        (loras ?? []).map((entry) => entry.name),
        cfg.allowedLoras,
        "lora",
      );

      if (!workflowPath && ((control?.length ?? 0) > 0 || ipAdapter || (loras?.length ?? 0) > 0)) {
        throw new Error("workflowPath is required when using control, ipAdapter, or loras");
      }

      const bridgeRequest: ComfyGenerateRequest = {
        mode,
        prompt,
        negative_prompt: negativePrompt,
        width: width ?? cfg.defaultWidth,
        height: height ?? cfg.defaultHeight,
        steps: steps ?? cfg.defaultSteps,
        guidance: guidance ?? cfg.defaultGuidance,
        seed,
        model,
        init_image_path: initImagePath,
        denoise: denoise ?? (mode === "img2img" ? cfg.defaultDenoise : undefined),
        control,
        ip_adapter: ipAdapter,
        loras,
        workflow_path: workflowPath,
        timeout_ms: timeoutMs,
      };

      const bridgeResult = await requestComfyGenerateSync({
        bridgeUrl: cfg.bridgeUrl,
        timeoutMs,
        request: bridgeRequest,
      });

      const outputImagePath = await assertOutputPath(bridgeResult.image_path, cfg.outputDir);
      const metadata = [
        `mode=${bridgeRequest.mode}`,
        `size=${bridgeResult.width ?? bridgeRequest.width}x${bridgeResult.height ?? bridgeRequest.height}`,
        `seed=${bridgeResult.seed ?? bridgeRequest.seed ?? "auto"}`,
        `model=${bridgeResult.model ?? bridgeRequest.model ?? "default"}`,
      ].join(", ");

      return {
        content: [
          { type: "text", text: `MEDIA:${outputImagePath}` },
          { type: "text", text: `Generated image (${metadata}).` },
        ],
        details: {
          ...bridgeResult,
          request: bridgeRequest,
        },
      };
    },
  };
}
