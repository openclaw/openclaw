export function createSelfContainedCandidatePackage(params: {
  packageDir: string;
  registryDir?: string;
  outputDir: string;
}): { bundled: string[]; sha256: string; version: string };
