import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SystemResources {
  totalRamGB: number;
  availableRamGB: number;
  cpuCores: number;
  cpuModel: string;
  hasGpu: boolean;
  gpuInfo?: string;
}

export async function getSystemResources(): Promise<SystemResources> {
  const totalRamGB = os.totalmem() / 1024 ** 3;
  const availableRamGB = os.freemem() / 1024 ** 3;
  const cpus = os.cpus();
  const cpuCores = cpus.length;
  const cpuModel = cpus[0]?.model ?? "unknown";

  let hasGpu = false;
  let gpuInfo: string | undefined;

  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=name,memory.total",
      "--format=csv,noheader",
    ]);
    if (stdout.trim()) {
      hasGpu = true;
      gpuInfo = stdout.trim();
    }
  } catch {
    // no nvidia GPU or nvidia-smi not installed
  }

  return { totalRamGB, availableRamGB, cpuCores, cpuModel, hasGpu, gpuInfo };
}

export function canFitModel(
  modelRamGB: number,
  resources: SystemResources,
): { fits: boolean; tight: boolean; message: string } {
  const headroom = resources.availableRamGB - modelRamGB;
  if (headroom < 0) {
    return {
      fits: false,
      tight: false,
      message: `Not enough RAM: need ${modelRamGB.toFixed(1)}GB but only ${resources.availableRamGB.toFixed(1)}GB available`,
    };
  }
  if (headroom < 1) {
    return {
      fits: true,
      tight: true,
      message: `Model fits but tight: only ${headroom.toFixed(1)}GB headroom`,
    };
  }
  return {
    fits: true,
    tight: false,
    message: `Model fits comfortably: ${headroom.toFixed(1)}GB headroom`,
  };
}

export function suggestOllamaOptions(resources: SystemResources): Record<string, unknown> {
  const opts: Record<string, unknown> = {};

  // Context window based on available RAM
  if (resources.availableRamGB < 4) {
    opts.num_ctx = 2048;
  } else if (resources.availableRamGB < 8) {
    opts.num_ctx = 4096;
  } else if (resources.availableRamGB < 16) {
    opts.num_ctx = 8192;
  } else {
    opts.num_ctx = 16384;
  }

  // Thread count — leave a couple cores for the system
  opts.num_thread = Math.max(1, resources.cpuCores - 2);

  // GPU layers
  if (resources.hasGpu) {
    opts.num_gpu = 999; // offload all layers to GPU
  } else {
    opts.num_gpu = 0;
  }

  return opts;
}

export async function unloadModel(
  modelName: string,
  baseUrl = "http://127.0.0.1:11434",
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelName, keep_alive: 0 }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `HTTP ${res.status}: ${text}` };
    }
    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export async function getMemoryPressure(): Promise<"low" | "medium" | "high" | "critical"> {
  const freeGB = os.freemem() / 1024 ** 3;
  if (freeGB < 1) {
    return "critical";
  }
  if (freeGB < 2) {
    return "high";
  }
  if (freeGB < 4) {
    return "medium";
  }
  return "low";
}
