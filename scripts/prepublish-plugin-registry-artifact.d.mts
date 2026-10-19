export const PREPUBLISH_PLUGIN_REGISTRY_MANIFEST: "prepublish-plugin-registry.json";

export type PrepublishPluginRegistryEntry = {
  name: string;
  version: string;
  tarball: string;
  sha256: string;
};

export type PrepublishPluginRegistryManifest = {
  schema: "openclaw.prepublish-plugin-registry/v1";
  schemaVersion: 1;
  sourceSha: string;
  candidateVersion: string;
  packages: PrepublishPluginRegistryEntry[];
};

export type ValidatePrepublishPluginRegistryParams = {
  artifactDir: string;
  expectedCandidateVersion: string;
  expectedManifestSha256: string;
  expectedSourceSha: string;
  requiredPackages: string[];
};

export type PrepublishPluginRegistryArtifact = {
  manifest: PrepublishPluginRegistryManifest;
  manifestPath: string;
  manifestSha256: string;
};

export function inspectNpmPackageTarball(tarball: string): {
  packageJson: Record<string, unknown>;
  sha256: string;
};

export function validatePrepublishPluginRegistryArtifact(
  params: ValidatePrepublishPluginRegistryParams,
): PrepublishPluginRegistryArtifact;

export function createPrepublishPluginRegistryArtifact(params: {
  repoRoot: string;
  outputDir: string;
  sourceSha: string;
  candidateVersion: string;
  requiredPackages: string[];
  preparedBundleDir?: string;
}): PrepublishPluginRegistryArtifact;
