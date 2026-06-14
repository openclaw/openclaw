export type CapabilityManifestVerifierConfig = {
  enabled: boolean;
  manifestJwtEnv: string;
  manifestPath?: string;
  manifestSecretEnv: string;
  agentId?: string;
  defaultDecision: "allow" | "deny";
  approvalTitle: string;
};

export const CapabilityManifestVerifierConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: {
      type: "boolean",
      default: true,
    },
    manifestJwtEnv: {
      type: "string",
      default: "OPENCLAW_CAPABILITY_MANIFEST_JWT",
    },
    manifestPath: {
      type: "string",
    },
    manifestSecretEnv: {
      type: "string",
      default: "OPENCLAW_CAPABILITY_MANIFEST_SECRET",
    },
    agentId: {
      type: "string",
    },
    defaultDecision: {
      type: "string",
      enum: ["allow", "deny"],
      default: "deny",
    },
    approvalTitle: {
      type: "string",
      default: "Capability manifest approval required",
    },
  },
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNonEmptyString(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function resolveCapabilityManifestVerifierConfig(
  raw: unknown,
): CapabilityManifestVerifierConfig {
  const cfg = asRecord(raw);
  const defaultDecision = cfg.defaultDecision === "allow" ? "allow" : "deny";
  return {
    enabled: readBoolean(cfg.enabled, true),
    manifestJwtEnv: readNonEmptyString(
      cfg.manifestJwtEnv,
      "OPENCLAW_CAPABILITY_MANIFEST_JWT",
    ) as string,
    ...(readNonEmptyString(cfg.manifestPath)
      ? { manifestPath: readNonEmptyString(cfg.manifestPath) }
      : {}),
    manifestSecretEnv: readNonEmptyString(
      cfg.manifestSecretEnv,
      "OPENCLAW_CAPABILITY_MANIFEST_SECRET",
    ) as string,
    ...(readNonEmptyString(cfg.agentId) ? { agentId: readNonEmptyString(cfg.agentId) } : {}),
    defaultDecision,
    approvalTitle:
      readNonEmptyString(cfg.approvalTitle, "Capability manifest approval required") ??
      "Capability manifest approval required",
  };
}
