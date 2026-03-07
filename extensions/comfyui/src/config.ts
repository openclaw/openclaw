import os from "node:os";
import path from "node:path";

export type ComfyPluginConfig = {
  bridgeUrl: string;
  timeoutMs: number;
  defaultModel?: string;
  allowedModels: string[];
  outputDir?: string;
  allowedPathRoots: string[];
  allowedControlTypes: string[];
  allowedLoras: string[];
  maxWidth: number;
  maxHeight: number;
  maxControls: number;
  maxLoras: number;
  defaultWidth: number;
  defaultHeight: number;
  defaultSteps: number;
  defaultGuidance: number;
  defaultDenoise: number;
};

const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8787";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_WIDTH = 2048;
const DEFAULT_MAX_HEIGHT = 2048;
const DEFAULT_MAX_CONTROLS = 4;
const DEFAULT_MAX_LORAS = 4;
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const DEFAULT_STEPS = 28;
const DEFAULT_GUIDANCE = 3.5;
const DEFAULT_DENOISE = 0.75;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringArray(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array of strings`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`${label} must be an array of strings`);
    }
    const trimmed = item.trim();
    if (trimmed) {
      out.push(trimmed);
    }
  }
  return out;
}

function readBoundedNumber(
  value: unknown,
  label: string,
  defaults: number,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    return defaults;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

function readAbsolutePath(value: unknown, label: string): string | undefined {
  const raw = readOptionalString(value, label);
  if (!raw) {
    return undefined;
  }
  return path.resolve(raw);
}

function readAbsolutePathArray(value: unknown, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  const entries = readStringArray(value, label);
  return entries.map((entry) => path.resolve(entry));
}

function defaultAllowedPathRoots(): string[] {
  return [path.resolve(process.cwd()), path.resolve(os.homedir()), path.resolve(os.tmpdir())];
}

export function resolveComfyPluginConfig(raw: unknown): ComfyPluginConfig {
  if (raw === undefined) {
    return {
      bridgeUrl: DEFAULT_BRIDGE_URL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      allowedModels: [],
      allowedPathRoots: defaultAllowedPathRoots(),
      allowedControlTypes: [],
      allowedLoras: [],
      maxWidth: DEFAULT_MAX_WIDTH,
      maxHeight: DEFAULT_MAX_HEIGHT,
      maxControls: DEFAULT_MAX_CONTROLS,
      maxLoras: DEFAULT_MAX_LORAS,
      defaultWidth: DEFAULT_WIDTH,
      defaultHeight: DEFAULT_HEIGHT,
      defaultSteps: DEFAULT_STEPS,
      defaultGuidance: DEFAULT_GUIDANCE,
      defaultDenoise: DEFAULT_DENOISE,
    };
  }

  const cfg = asRecord(raw, "comfyui config");
  const bridgeUrl = readOptionalString(cfg.bridgeUrl, "bridgeUrl") ?? DEFAULT_BRIDGE_URL;
  const timeoutMs = readBoundedNumber(
    cfg.timeoutMs,
    "timeoutMs",
    DEFAULT_TIMEOUT_MS,
    1000,
    600_000,
  );
  const defaultModel = readOptionalString(cfg.defaultModel, "defaultModel");
  const outputDir = readAbsolutePath(cfg.outputDir, "outputDir");
  const allowedPathRootsRaw = readAbsolutePathArray(cfg.allowedPathRoots, "allowedPathRoots");
  const allowedPathRoots =
    allowedPathRootsRaw.length > 0 ? allowedPathRootsRaw : defaultAllowedPathRoots();

  return {
    bridgeUrl,
    timeoutMs,
    defaultModel,
    allowedModels: readStringArray(cfg.allowedModels, "allowedModels"),
    outputDir,
    allowedPathRoots,
    allowedControlTypes: readStringArray(cfg.allowedControlTypes, "allowedControlTypes"),
    allowedLoras: readStringArray(cfg.allowedLoras, "allowedLoras"),
    maxWidth: readBoundedNumber(cfg.maxWidth, "maxWidth", DEFAULT_MAX_WIDTH, 64, 4096),
    maxHeight: readBoundedNumber(cfg.maxHeight, "maxHeight", DEFAULT_MAX_HEIGHT, 64, 4096),
    maxControls: readBoundedNumber(cfg.maxControls, "maxControls", DEFAULT_MAX_CONTROLS, 0, 8),
    maxLoras: readBoundedNumber(cfg.maxLoras, "maxLoras", DEFAULT_MAX_LORAS, 0, 8),
    defaultWidth: readBoundedNumber(cfg.defaultWidth, "defaultWidth", DEFAULT_WIDTH, 64, 4096),
    defaultHeight: readBoundedNumber(cfg.defaultHeight, "defaultHeight", DEFAULT_HEIGHT, 64, 4096),
    defaultSteps: readBoundedNumber(cfg.defaultSteps, "defaultSteps", DEFAULT_STEPS, 1, 200),
    defaultGuidance: readBoundedNumber(
      cfg.defaultGuidance,
      "defaultGuidance",
      DEFAULT_GUIDANCE,
      0,
      30,
    ),
    defaultDenoise: readBoundedNumber(cfg.defaultDenoise, "defaultDenoise", DEFAULT_DENOISE, 0, 1),
  };
}

function normalizeForComparison(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathUnderRoots(candidate: string, roots: string[]): boolean {
  const normalizedCandidate = normalizeForComparison(candidate);
  for (const root of roots) {
    const normalizedRoot = normalizeForComparison(root);
    if (normalizedCandidate === normalizedRoot) {
      return true;
    }
    if (normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)) {
      return true;
    }
  }
  return false;
}
