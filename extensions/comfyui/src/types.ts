export type ComfyGenerateMode = "txt2img" | "img2img";

export type ComfyControlInput = {
  type: string;
  image_path: string;
  strength?: number;
  start?: number;
  end?: number;
};

export type ComfyIpAdapterInput = {
  image_path: string;
  weight?: number;
};

export type ComfyLoraInput = {
  name: string;
  scale?: number;
};

export type ComfyGenerateRequest = {
  mode: ComfyGenerateMode;
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  seed?: number;
  model?: string;
  init_image_path?: string;
  denoise?: number;
  control?: ComfyControlInput[];
  ip_adapter?: ComfyIpAdapterInput;
  loras?: ComfyLoraInput[];
  workflow_path?: string;
  timeout_ms: number;
};

export type ComfyGenerateResponse = {
  ok: true;
  job_id: string;
  image_path: string;
  width?: number;
  height?: number;
  seed?: number;
  model?: string;
  timings_ms?: Record<string, number>;
};

export type ComfyBridgeError = {
  ok: false;
  code?: string;
  message: string;
  details?: unknown;
};
