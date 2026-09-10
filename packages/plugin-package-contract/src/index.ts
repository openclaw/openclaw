// External code plugin package.json compatibility and validation contracts.
import { isRecord } from "../../normalization-core/src/record-coerce.js";
import { normalizeOptionalString } from "../../normalization-core/src/string-coerce.js";

/** JSON object shape accepted by package contract helpers. */
export type JsonObject = Record<string, unknown>;

/** Compatibility metadata extracted from an external plugin package. */
export type ExternalPluginCompatibility = {
  pluginApiRange?: string;
  builtWithOpenClawVersion?: string;
  pluginSdkVersion?: string;
  minGatewayVersion?: string;
};

/** One validation issue for an external plugin package. */
export type ExternalPluginValidationIssue = {
  fieldPath: string;
  message: string;
};

/** Validation result plus any normalized compatibility metadata. */
export type ExternalCodePluginValidationResult = {
  compatibility?: ExternalPluginCompatibility;
  issues: ExternalPluginValidationIssue[];
};

/** Required package.json field paths for external code plugin packages. */
export const EXTERNAL_CODE_PLUGIN_REQUIRED_FIELD_PATHS = [
  "openclaw.compat.pluginApi",
  "openclaw.build.openclawVersion",
] as const;

/** Controlled browse categories accepted by native OpenClaw plugin manifests. */
export const PLUGIN_CATEGORY_SLUGS = [
  "channels",
  "models",
  "memory",
  "context",
  "voice",
  "media",
  "web",
  "tools",
  "runtime",
  "gateway",
  "security",
  "other",
] as const;

export type PluginCategorySlug = (typeof PLUGIN_CATEGORY_SLUGS)[number];

export type PluginCategoriesValidationResult =
  | { ok: true; categories?: PluginCategorySlug[] }
  | { ok: false; error: string };

/** Validate optional ordered package-owned plugin categories. */
export function validatePluginCategories(value: unknown): PluginCategoriesValidationResult {
  if (value === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: "must be an array" };
  }
  if (value.length < 1 || value.length > 3) {
    return { ok: false, error: "must contain between 1 and 3 entries" };
  }
  const categories: PluginCategorySlug[] = [];
  for (const entry of value) {
    const category = PLUGIN_CATEGORY_SLUGS.find((candidate) => candidate === entry);
    if (!category) {
      return { ok: false, error: `contains unknown category ${JSON.stringify(entry)}` };
    }
    if (categories.includes(category)) {
      return { ok: false, error: "must not contain duplicates" };
    }
    categories.push(category);
  }
  return { ok: true, categories };
}

/** Read OpenClaw package.json blocks without trusting caller input shape. */
function readOpenClawBlock(packageJson: unknown) {
  const root = isRecord(packageJson) ? packageJson : undefined;
  const openclaw = isRecord(root?.openclaw) ? root.openclaw : undefined;
  const compat = isRecord(openclaw?.compat) ? openclaw.compat : undefined;
  const build = isRecord(openclaw?.build) ? openclaw.build : undefined;
  const install = isRecord(openclaw?.install) ? openclaw.install : undefined;
  return { root, openclaw, compat, build, install };
}

/** Normalize compatibility metadata from an external plugin package.json. */
export function normalizeExternalPluginCompatibility(
  packageJson: unknown,
): ExternalPluginCompatibility | undefined {
  const { root, compat, build, install } = readOpenClawBlock(packageJson);
  const version = normalizeOptionalString(root?.version);
  const minHostVersion = normalizeOptionalString(install?.minHostVersion);
  const compatibility: ExternalPluginCompatibility = {};

  const pluginApi = normalizeOptionalString(compat?.pluginApi);
  if (pluginApi) {
    compatibility.pluginApiRange = pluginApi;
  }

  const minGatewayVersion = normalizeOptionalString(compat?.minGatewayVersion) ?? minHostVersion;
  if (minGatewayVersion) {
    compatibility.minGatewayVersion = minGatewayVersion;
  }

  const builtWithOpenClawVersion = normalizeOptionalString(build?.openclawVersion) ?? version;
  if (builtWithOpenClawVersion) {
    compatibility.builtWithOpenClawVersion = builtWithOpenClawVersion;
  }

  const pluginSdkVersion = normalizeOptionalString(build?.pluginSdkVersion);
  if (pluginSdkVersion) {
    compatibility.pluginSdkVersion = pluginSdkVersion;
  }

  return Object.keys(compatibility).length > 0 ? compatibility : undefined;
}

/** List missing required field paths for an external code plugin package.json. */
export function listMissingExternalCodePluginFieldPaths(packageJson: unknown): string[] {
  const { compat, build } = readOpenClawBlock(packageJson);
  const missing: string[] = [];
  if (!normalizeOptionalString(compat?.pluginApi)) {
    missing.push("openclaw.compat.pluginApi");
  }
  if (!normalizeOptionalString(build?.openclawVersion)) {
    missing.push("openclaw.build.openclawVersion");
  }
  return missing;
}

/** Validate an external code plugin package.json against required compatibility fields. */
export function validateExternalCodePluginPackageJson(
  packageJson: unknown,
): ExternalCodePluginValidationResult {
  const issues = listMissingExternalCodePluginFieldPaths(packageJson).map((fieldPath) => ({
    fieldPath,
    message: `${fieldPath} is required for external code plugin packages.`,
  }));
  return {
    compatibility: normalizeExternalPluginCompatibility(packageJson),
    issues,
  };
}
