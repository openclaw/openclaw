import { z } from "zod";

/**
 * Matrix channel configuration schema.
 *
 * **Single-account limitation:** Only one Matrix account is supported per gateway
 * instance. OlmMachine, the sync loop, and room state caches are global singletons.
 * If multiple accounts are configured, only the first is used. Multi-account support
 * is planned for Phase 3 and requires per-account isolation of crypto and sync state.
 */
export const MatrixConfigSchema = z.object({
  enabled: z.boolean().default(true),
  homeserver: z
    .string()
    .url()
    .refine((s) => s.startsWith("https://"), { message: "Must be HTTPS" })
    .transform((s) => {
      // Strip to origin only (no trailing path/slashes) — Rust SDK is sensitive to canonicalization
      try {
        const u = new URL(s);
        return u.origin;
      } catch {
        return s.replace(/\/+$/, "");
      }
    }),
  userId: z.string().regex(/^@[\w.-]+:[\w.-]+$/, "Must be @user:domain format"),
  accessToken: z.string().min(1),
  password: z.string().optional(),
  encryption: z.boolean().default(true),
  deviceName: z.string().default("OpenClaw"),
  dm: z
    .object({
      policy: z.enum(["pairing", "allowlist", "open", "disabled"]).default("allowlist"),
      allowFrom: z.array(z.string()).default([]),
    })
    .default(() => ({ policy: "allowlist" as const, allowFrom: [] })),
  groupPolicy: z.enum(["allowlist", "open", "disabled"]).default("allowlist"),
  groups: z
    .record(
      z.string(),
      z.object({
        allow: z.boolean().default(true),
        requireMention: z.boolean().default(false),
      }),
    )
    .default({}),
  groupAllowFrom: z.array(z.string()).default([]),
  chunkMode: z.enum(["length", "paragraph"]).default("length"),
  textChunkLimit: z.number().default(4096),
  recoveryKey: z.string().optional(),
  trustMode: z.enum(["tofu", "strict"]).default("tofu"),
  autoJoin: z.enum(["always", "allowlist", "off"]).default("off"),
  autoJoinAllowFrom: z.array(z.string()).default([]),
  replyToMode: z.enum(["off", "first", "all"]).default("first"),
  maxMediaSize: z.number().default(52_428_800), // 50MB
  rateLimitTokens: z.number().default(10),
  rateLimitRefillPerSec: z.number().default(2),
});

export type MatrixConfig = z.infer<typeof MatrixConfigSchema>;

/**
 * Resolved account config. Derived from MatrixConfig (Zod output) plus accountId.
 *
 * Using MatrixConfig as the base ensures the types stay in sync with the Zod schema.
 * The fallback path in resolveMatrixAccount() manually constructs the same shape,
 * so any schema changes will cause a type error at the fallback construction site.
 */
export type ResolvedMatrixAccount = MatrixConfig & {
  accountId: string;
};

/**
 * Resolve Matrix account config from OpenClaw config.
 * Reads from channels.matrix in openclaw.json.
 *
 * Uses Zod schema for validation and defaults. Falls back to manual
 * extraction only if Zod parse fails (e.g., self-signed HTTPS URLs
 * that fail the URL validator).
 */
export function resolveMatrixAccount(
  cfg: unknown,
  accountId?: string | null,
): ResolvedMatrixAccount {
  // Single-account limitation: only "default" (or null/undefined) is supported.
  // Multi-account requires per-account isolation of crypto, sync, and room state.
  if (accountId != null && accountId !== "default") {
    throw new Error(
      `[claw-matrix] Account "${accountId}" not supported: only a single account ("default") is implemented. Multi-account is planned for Phase 3.`,
    );
  }

  const matrixCfg = (cfg as any)?.channels?.matrix ?? {};

  // Try Zod parse first for proper validation + defaults
  const parseResult = MatrixConfigSchema.safeParse(matrixCfg);
  if (parseResult.success) {
    const parsed = parseResult.data;
    return {
      accountId: accountId ?? "default",
      enabled: parsed.enabled,
      homeserver: parsed.homeserver,
      userId: parsed.userId,
      accessToken: parsed.accessToken,
      password: parsed.password,
      encryption: parsed.encryption,
      deviceName: parsed.deviceName,
      dm: parsed.dm,
      groupPolicy: parsed.groupPolicy,
      groups: parsed.groups,
      groupAllowFrom: parsed.groupAllowFrom,
      chunkMode: parsed.chunkMode,
      textChunkLimit: parsed.textChunkLimit,
      recoveryKey: parsed.recoveryKey,
      trustMode: parsed.trustMode,
      autoJoin: parsed.autoJoin,
      autoJoinAllowFrom: parsed.autoJoinAllowFrom,
      replyToMode: parsed.replyToMode,
      maxMediaSize: parsed.maxMediaSize,
      rateLimitTokens: parsed.rateLimitTokens,
      rateLimitRefillPerSec: parsed.rateLimitRefillPerSec,
    };
  }

  // Log validation errors for debugging before falling back
  const issues = parseResult.error?.issues ?? [];
  if (issues.length > 0) {
    const details = issues.map((i: any) => `${i.path?.join(".")}: ${i.message}`).join("; ");
    console.warn(`[claw-matrix] Config validation failed, using fallback: ${details}`);
  }

  // Fallback: manual extraction (for configs that fail strict validation)
  return {
    accountId: accountId ?? "default",
    enabled: matrixCfg.enabled !== false,
    homeserver: (() => {
      const raw = matrixCfg.homeserver ?? "";
      try {
        return new URL(raw).origin;
      } catch {
        return raw.replace(/\/+$/, "");
      }
    })(),
    userId: matrixCfg.userId ?? "",
    accessToken: matrixCfg.accessToken ?? "",
    password: matrixCfg.password,
    encryption: matrixCfg.encryption !== false,
    deviceName: matrixCfg.deviceName ?? "OpenClaw",
    dm: {
      policy: matrixCfg.dm?.policy ?? "allowlist",
      allowFrom: matrixCfg.dm?.allowFrom ?? [],
    },
    groupPolicy: matrixCfg.groupPolicy ?? "allowlist",
    groups: matrixCfg.groups ?? {},
    groupAllowFrom: matrixCfg.groupAllowFrom ?? [],
    chunkMode: matrixCfg.chunkMode ?? "length",
    textChunkLimit: matrixCfg.textChunkLimit ?? 4096,
    recoveryKey: matrixCfg.recoveryKey,
    trustMode: matrixCfg.trustMode ?? "tofu",
    autoJoin: matrixCfg.autoJoin ?? "off",
    autoJoinAllowFrom: matrixCfg.autoJoinAllowFrom ?? [],
    replyToMode: matrixCfg.replyToMode ?? "first",
    maxMediaSize: matrixCfg.maxMediaSize ?? 52_428_800,
    rateLimitTokens: matrixCfg.rateLimitTokens ?? 10,
    rateLimitRefillPerSec: matrixCfg.rateLimitRefillPerSec ?? 2,
  };
}
