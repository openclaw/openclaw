import { Type } from "@sinclair/typebox";

export const wigForgeConfigSchema = Type.Object(
  {
    storageDir: Type.Optional(Type.String({ minLength: 1 })),
    maxSourceBytes: Type.Optional(Type.Integer({ minimum: 1024, maximum: 10 * 1024 * 1024 })),
    defaultTaskQuality: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    defaultMaskQuality: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    defaultNovelty: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    r2: Type.Optional(
      Type.Object(
        {
          accountId: Type.Optional(Type.String({ minLength: 1 })),
          bucket: Type.Optional(Type.String({ minLength: 1 })),
          accessKeyId: Type.Optional(Type.String({ minLength: 1 })),
          secretAccessKey: Type.Optional(Type.String({ minLength: 1 })),
          publicBaseUrl: Type.Optional(Type.String({ minLength: 1 })),
          keyPrefix: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type WigForgeResolvedR2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl?: string;
  keyPrefix?: string;
};

export type WigForgeResolvedConfig = {
  storageDir?: string;
  maxSourceBytes: number;
  defaultTaskQuality: number;
  defaultMaskQuality: number;
  defaultNovelty: number;
  r2?: WigForgeResolvedR2Config;
};

function clamp01(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizePublicBaseUrl(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\/+$/g, "");
}

function resolveR2Config(raw?: Record<string, unknown>): WigForgeResolvedR2Config | undefined {
  const rawR2 = raw?.r2;
  const r2 = rawR2 && typeof rawR2 === "object" ? (rawR2 as Record<string, unknown>) : undefined;
  const accountId = firstNonEmptyString(r2?.accountId, process.env.WIG_FORGE_R2_ACCOUNT_ID);
  const bucket = firstNonEmptyString(r2?.bucket, process.env.WIG_FORGE_R2_BUCKET);
  const accessKeyId = firstNonEmptyString(r2?.accessKeyId, process.env.WIG_FORGE_R2_ACCESS_KEY_ID);
  const secretAccessKey = firstNonEmptyString(
    r2?.secretAccessKey,
    process.env.WIG_FORGE_R2_SECRET_ACCESS_KEY,
  );

  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    return undefined;
  }

  return {
    accountId,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: normalizePublicBaseUrl(
      firstNonEmptyString(r2?.publicBaseUrl, process.env.WIG_FORGE_R2_PUBLIC_BASE_URL),
    ),
    keyPrefix: firstNonEmptyString(r2?.keyPrefix, process.env.WIG_FORGE_R2_KEY_PREFIX),
  };
}

export function resolveWigForgeConfig(raw?: Record<string, unknown>): WigForgeResolvedConfig {
  return {
    storageDir:
      typeof raw?.storageDir === "string" && raw.storageDir.trim() ? raw.storageDir : undefined,
    maxSourceBytes:
      typeof raw?.maxSourceBytes === "number" && Number.isInteger(raw.maxSourceBytes)
        ? Math.min(10 * 1024 * 1024, Math.max(1024, raw.maxSourceBytes))
        : 4 * 1024 * 1024,
    defaultTaskQuality: clamp01(raw?.defaultTaskQuality, 0.72),
    defaultMaskQuality: clamp01(raw?.defaultMaskQuality, 0.78),
    defaultNovelty: clamp01(raw?.defaultNovelty, 0.7),
    r2: resolveR2Config(raw),
  };
}
