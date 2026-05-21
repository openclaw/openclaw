import { stat } from "node:fs/promises";

export type WikiInjectableOutputName = "digest" | "claims" | "manifest";

export type WikiInjectableOutput = {
  name: WikiInjectableOutputName;
  path: string | null;
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  mtime?: string;
  ageMs?: number;
  stale?: boolean;
  reason: string | null;
};

export type WikiInjectableResult = {
  injectable: boolean;
  reason: string | null;
  now: string;
  maxAgeMs: number;
  requiredOutputs: WikiInjectableOutputName[];
  outputs: Record<string, WikiInjectableOutput>;
};

const DEFAULT_REQUIRED_OUTPUTS: WikiInjectableOutputName[] = ["digest", "claims"];

function toMillis(value: Date | number | string | undefined): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function normalizeRequiredOutputs(requiredOutputs?: WikiInjectableOutputName[]) {
  const raw = requiredOutputs?.length ? requiredOutputs : DEFAULT_REQUIRED_OUTPUTS;
  return [...new Set(raw.map((item) => item.trim()).filter(Boolean))] as WikiInjectableOutputName[];
}

async function statOutput(
  name: WikiInjectableOutputName,
  filePath: string | undefined,
  nowMs: number,
  maxAgeMs: number,
): Promise<WikiInjectableOutput> {
  if (!filePath) {
    return {
      name,
      path: null,
      exists: false,
      reason: `${name}_path_missing`,
    };
  }

  try {
    const info = await stat(filePath);
    const ageMs = Math.max(0, nowMs - info.mtimeMs);
    const stale = ageMs > maxAgeMs;
    return {
      name,
      path: filePath,
      exists: true,
      size: info.size,
      mtimeMs: info.mtimeMs,
      mtime: new Date(info.mtimeMs).toISOString(),
      ageMs,
      stale,
      reason: stale ? `${name}_stale` : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        name,
        path: filePath,
        exists: false,
        reason: `${name}_missing`,
      };
    }
    throw error;
  }
}

export async function isWikiInjectable(params: {
  now?: Date | number | string;
  digestPath?: string;
  claimsPath?: string;
  manifestPath?: string;
  maxAgeMs: number;
  requiredOutputs?: WikiInjectableOutputName[];
}): Promise<WikiInjectableResult> {
  if (!Number.isFinite(params.maxAgeMs) || params.maxAgeMs <= 0) {
    throw new Error("maxAgeMs must be a positive finite number");
  }

  const nowMs = toMillis(params.now);
  const requiredOutputs = normalizeRequiredOutputs(params.requiredOutputs);
  const pathByName: Record<WikiInjectableOutputName, string | undefined> = {
    digest: params.digestPath,
    claims: params.claimsPath,
    manifest: params.manifestPath,
  };

  const outputs: Record<string, WikiInjectableOutput> = {};
  for (const name of requiredOutputs) {
    outputs[name] = await statOutput(name, pathByName[name], nowMs, params.maxAgeMs);
  }

  const failed = requiredOutputs
    .map((name) => outputs[name])
    .find((output) => !output?.exists || output.stale);

  return {
    injectable: !failed,
    reason: failed?.reason ?? null,
    now: new Date(nowMs).toISOString(),
    maxAgeMs: params.maxAgeMs,
    requiredOutputs,
    outputs,
  };
}
