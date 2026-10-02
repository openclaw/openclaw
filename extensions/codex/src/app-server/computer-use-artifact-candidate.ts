import { resolveCodexManagedBundledMarketplaceSource } from "./computer-use-marketplace.js";
import { resolveCodexComputerUseServiceAppSourcePath } from "./computer-use-service.js";
import type { MacOSDesktopCodexAppPathCandidate } from "./desktop-app-paths.js";

export async function resolveCompleteComputerUseArtifactCandidate(params: {
  candidates: readonly MacOSDesktopCodexAppPathCandidate[];
  needsBundledMarketplace: boolean;
}): Promise<MacOSDesktopCodexAppPathCandidate | undefined> {
  for (const candidate of params.candidates) {
    if (
      params.needsBundledMarketplace &&
      !(await resolveCodexManagedBundledMarketplaceSource({ candidates: [candidate] }))
    ) {
      continue;
    }
    if (
      await resolveCodexComputerUseServiceAppSourcePath({
        sourceAppCandidates: candidate.computerUseServiceAppPaths,
      })
    ) {
      return candidate;
    }
  }
  return undefined;
}
