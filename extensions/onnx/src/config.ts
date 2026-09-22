import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { Type } from "typebox";

export const ConfigSchema = Type.Object(
  {
    modelDir: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    threads: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 2 })),
    maxLoadedModels: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, default: 2 })),
  },
  { additionalProperties: false },
);

export type WorkerConfig = {
  modelDir: string;
  threads: number;
  maxLoadedModels: number;
};

export function resolveOnnxConfig(
  config: Record<string, unknown> | undefined,
  resolvePath: (value: string) => string,
): WorkerConfig {
  const modelDir = config?.modelDir ?? path.join(resolveStateDir(), "models", "onnx");
  const threads = config?.threads ?? 2;
  const maxLoadedModels = config?.maxLoadedModels ?? 2;
  if (
    typeof modelDir !== "string" ||
    !modelDir.trim() ||
    typeof threads !== "number" ||
    !Number.isInteger(threads) ||
    threads < 1 ||
    threads > 8 ||
    typeof maxLoadedModels !== "number" ||
    !Number.isInteger(maxLoadedModels) ||
    maxLoadedModels < 1 ||
    maxLoadedModels > 5
  ) {
    throw new Error("Invalid ONNX configuration; check modelDir, threads, and maxLoadedModels.");
  }
  return { modelDir: path.resolve(resolvePath(modelDir)), threads, maxLoadedModels };
}
