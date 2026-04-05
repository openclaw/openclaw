export type JsonObject = Record<string, unknown>;

export type ExternalPluginCompatibility = {
  pluginApiRange?: string;
  builtWithMullusiVersion?: string;
  pluginSdkVersion?: string;
  minGatewayVersion?: string;
};

export type ExternalPluginValidationIssue = {
  fieldPath: string;
  message: string;
};

export type ExternalCodePluginValidationResult = {
  compatibility?: ExternalPluginCompatibility;
  issues: ExternalPluginValidationIssue[];
};

export const EXTERNAL_CODE_PLUGIN_REQUIRED_FIELD_PATHS = [
  "mullusi.compat.pluginApi",
  "mullusi.build.mullusiVersion",
] as const;

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readMullusiBlock(packageJson: unknown) {
  const root = isRecord(packageJson) ? packageJson : undefined;
  const mullusi = isRecord(root?.mullusi) ? root.mullusi : undefined;
  const compat = isRecord(mullusi?.compat) ? mullusi.compat : undefined;
  const build = isRecord(mullusi?.build) ? mullusi.build : undefined;
  const install = isRecord(mullusi?.install) ? mullusi.install : undefined;
  return { root, mullusi, compat, build, install };
}

export function normalizeExternalPluginCompatibility(
  packageJson: unknown,
): ExternalPluginCompatibility | undefined {
  const { root, compat, build, install } = readMullusiBlock(packageJson);
  const version = getTrimmedString(root?.version);
  const minHostVersion = getTrimmedString(install?.minHostVersion);
  const compatibility: ExternalPluginCompatibility = {};

  const pluginApi = getTrimmedString(compat?.pluginApi);
  if (pluginApi) {
    compatibility.pluginApiRange = pluginApi;
  }

  const minGatewayVersion = getTrimmedString(compat?.minGatewayVersion) ?? minHostVersion;
  if (minGatewayVersion) {
    compatibility.minGatewayVersion = minGatewayVersion;
  }

  const builtWithMullusiVersion = getTrimmedString(build?.mullusiVersion) ?? version;
  if (builtWithMullusiVersion) {
    compatibility.builtWithMullusiVersion = builtWithMullusiVersion;
  }

  const pluginSdkVersion = getTrimmedString(build?.pluginSdkVersion);
  if (pluginSdkVersion) {
    compatibility.pluginSdkVersion = pluginSdkVersion;
  }

  return Object.keys(compatibility).length > 0 ? compatibility : undefined;
}

export function listMissingExternalCodePluginFieldPaths(packageJson: unknown): string[] {
  const { compat, build } = readMullusiBlock(packageJson);
  const missing: string[] = [];
  if (!getTrimmedString(compat?.pluginApi)) {
    missing.push("mullusi.compat.pluginApi");
  }
  if (!getTrimmedString(build?.mullusiVersion)) {
    missing.push("mullusi.build.mullusiVersion");
  }
  return missing;
}

export function validateExternalCodePluginPackageJson(
  packageJson: unknown,
): ExternalCodePluginValidationResult {
  const issues = listMissingExternalCodePluginFieldPaths(packageJson).map((fieldPath) => ({
    fieldPath,
    message: `${fieldPath} is required for external code plugins published to ClawHub.`,
  }));
  return {
    compatibility: normalizeExternalPluginCompatibility(packageJson),
    issues,
  };
}
