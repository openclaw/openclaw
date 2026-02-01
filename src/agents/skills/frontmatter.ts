import type { Skill } from "@mariozechner/pi-coding-agent";
import JSON5 from "json5";
import type {
  OpenClawSkillMetadata,
  ParsedSkillFrontmatter,
  SkillEntry,
  SkillInstallSpec,
  SkillInvocationPolicy,
  SkillPermissionManifest,
} from "./types.js";
import { LEGACY_MANIFEST_KEYS, MANIFEST_KEY } from "../../compat/legacy-names.js";
import { parseFrontmatterBlock } from "../../markdown/frontmatter.js";
import { parseBooleanValue } from "../../utils/boolean.js";

export function parseFrontmatter(content: string): ParsedSkillFrontmatter {
  return parseFrontmatterBlock(content);
}

function normalizeStringList(input: unknown): string[] {
  if (!input) {
    return [];
  }
  if (Array.isArray(input)) {
    return input.map((value) => String(value).trim()).filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

function parseInstallSpec(input: unknown): SkillInstallSpec | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const kindRaw =
    typeof raw.kind === "string" ? raw.kind : typeof raw.type === "string" ? raw.type : "";
  const kind = kindRaw.trim().toLowerCase();
  if (kind !== "brew" && kind !== "node" && kind !== "go" && kind !== "uv" && kind !== "download") {
    return undefined;
  }

  const spec: SkillInstallSpec = {
    kind: kind,
  };

  if (typeof raw.id === "string") {
    spec.id = raw.id;
  }
  if (typeof raw.label === "string") {
    spec.label = raw.label;
  }
  const bins = normalizeStringList(raw.bins);
  if (bins.length > 0) {
    spec.bins = bins;
  }
  const osList = normalizeStringList(raw.os);
  if (osList.length > 0) {
    spec.os = osList;
  }
  if (typeof raw.formula === "string") {
    spec.formula = raw.formula;
  }
  if (typeof raw.package === "string") {
    spec.package = raw.package;
  }
  if (typeof raw.module === "string") {
    spec.module = raw.module;
  }
  if (typeof raw.url === "string") {
    spec.url = raw.url;
  }
  if (typeof raw.archive === "string") {
    spec.archive = raw.archive;
  }
  if (typeof raw.extract === "boolean") {
    spec.extract = raw.extract;
  }
  if (typeof raw.stripComponents === "number") {
    spec.stripComponents = raw.stripComponents;
  }
  if (typeof raw.targetDir === "string") {
    spec.targetDir = raw.targetDir;
  }

  return spec;
}

function getFrontmatterValue(frontmatter: ParsedSkillFrontmatter, key: string): string | undefined {
  const raw = frontmatter[key];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Get metadata from frontmatter, handling both JSON5 string and YAML object formats.
 */
function getMetadataObject(
  frontmatter: ParsedSkillFrontmatter,
): Record<string, unknown> | undefined {
  const raw = frontmatter.metadata;
  if (!raw) return undefined;

  // Handle YAML-style object metadata (preferred)
  if (typeof raw === "object" && raw !== null) {
    return raw as Record<string, unknown>;
  }

  // Handle legacy JSON5 string metadata
  if (typeof raw === "string") {
    try {
      const parsed = JSON5.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function parseFrontmatterBool(value: string | undefined, fallback: boolean): boolean {
  const parsed = parseBooleanValue(value);
  return parsed === undefined ? fallback : parsed;
}

export function resolveOpenClawMetadata(
  frontmatter: ParsedSkillFrontmatter,
): OpenClawSkillMetadata | undefined {
  const parsed = getMetadataObject(frontmatter);
  if (!parsed) {
    return undefined;
  }
  try {
    const metadataRawCandidates = [MANIFEST_KEY, ...LEGACY_MANIFEST_KEYS];
    let metadataRaw: unknown;
    for (const key of metadataRawCandidates) {
      const candidate = parsed[key];
      if (candidate && typeof candidate === "object") {
        metadataRaw = candidate;
        break;
      }
    }
    if (!metadataRaw || typeof metadataRaw !== "object") {
      return undefined;
    }
    const metadataObj = metadataRaw as Record<string, unknown>;
    const requiresRaw =
      typeof metadataObj.requires === "object" && metadataObj.requires !== null
        ? (metadataObj.requires as Record<string, unknown>)
        : undefined;
    const installRaw = Array.isArray(metadataObj.install) ? (metadataObj.install as unknown[]) : [];
    const install = installRaw
      .map((entry) => parseInstallSpec(entry))
      .filter((entry): entry is SkillInstallSpec => Boolean(entry));
    const osRaw = normalizeStringList(metadataObj.os);
    return {
      always: typeof metadataObj.always === "boolean" ? metadataObj.always : undefined,
      emoji: typeof metadataObj.emoji === "string" ? metadataObj.emoji : undefined,
      homepage: typeof metadataObj.homepage === "string" ? metadataObj.homepage : undefined,
      skillKey: typeof metadataObj.skillKey === "string" ? metadataObj.skillKey : undefined,
      primaryEnv: typeof metadataObj.primaryEnv === "string" ? metadataObj.primaryEnv : undefined,
      os: osRaw.length > 0 ? osRaw : undefined,
      requires: requiresRaw
        ? {
            bins: normalizeStringList(requiresRaw.bins),
            anyBins: normalizeStringList(requiresRaw.anyBins),
            env: normalizeStringList(requiresRaw.env),
            config: normalizeStringList(requiresRaw.config),
          }
        : undefined,
      install: install.length > 0 ? install : undefined,
    };
  } catch {
    return undefined;
  }
}

export function resolveSkillInvocationPolicy(
  frontmatter: ParsedSkillFrontmatter,
): SkillInvocationPolicy {
  return {
    userInvocable: parseFrontmatterBool(getFrontmatterValue(frontmatter, "user-invocable"), true),
    disableModelInvocation: parseFrontmatterBool(
      getFrontmatterValue(frontmatter, "disable-model-invocation"),
      false,
    ),
  };
}

export function resolveSkillKey(skill: Skill, entry?: SkillEntry): string {
  return entry?.metadata?.skillKey ?? skill.name;
}

/**
 * Parse sensitive data flags from permission manifest.
 */
function parseSensitiveDataFlags(
  raw: unknown,
): SkillPermissionManifest["sensitive_data"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  return {
    credentials: obj.credentials === true,
    personal_info: obj.personal_info === true,
    financial: obj.financial === true,
  };
}

/**
 * Parse permission manifest from skill frontmatter metadata.
 */
export function parsePermissionManifest(
  frontmatter: ParsedSkillFrontmatter,
): SkillPermissionManifest | undefined {
  const parsed = getMetadataObject(frontmatter);
  if (!parsed) return undefined;

  try {
    const metadataRawCandidates = [MANIFEST_KEY, ...LEGACY_MANIFEST_KEYS];
    let openclawMeta: Record<string, unknown> | undefined;

    for (const key of metadataRawCandidates) {
      const candidate = parsed[key];
      if (candidate && typeof candidate === "object") {
        openclawMeta = candidate as Record<string, unknown>;
        break;
      }
    }

    if (!openclawMeta) return undefined;

    const permissions = openclawMeta.permissions as Record<string, unknown> | undefined;
    if (!permissions) return undefined;

    return {
      version: 1,
      filesystem: normalizeStringList(permissions.filesystem),
      network: normalizeStringList(permissions.network),
      env: normalizeStringList(permissions.env),
      exec: normalizeStringList(permissions.exec),
      declared_purpose:
        typeof permissions.declared_purpose === "string" ? permissions.declared_purpose : undefined,
      elevated: typeof permissions.elevated === "boolean" ? permissions.elevated : undefined,
      system_config:
        typeof permissions.system_config === "boolean" ? permissions.system_config : undefined,
      sensitive_data: parseSensitiveDataFlags(permissions.sensitive_data),
      security_notes:
        typeof permissions.security_notes === "string" ? permissions.security_notes : undefined,
    };
  } catch {
    return undefined;
  }
}
