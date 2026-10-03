/** Shared path candidates for Codex's macOS desktop app bundle. */
import { existsSync } from "node:fs";
import path from "node:path";
import {
  findMacOSDesktopCodexExecutable,
  resolveMacOSDesktopCodexAppBundlePath,
  resolveMacOSDesktopCodexAppPathCandidates,
  resolveMacOSDesktopCodexAppPathCandidatesForBundle,
  type MacOSDesktopCodexAppPathCandidate,
} from "./desktop-app-layout.js";
import {
  isCodexManagedRuntimeAppPath,
  readCodexManagedRuntimeSelection,
  type CodexManagedRuntimeStateOptions,
} from "./managed-runtime-installation.js";
export {
  resolveMacOSDesktopCodexAppPathCandidates,
  resolveMacOSDesktopCodexAppBundlePath,
} from "./desktop-app-layout.js";
export type { MacOSDesktopCodexAppPathCandidate } from "./desktop-app-layout.js";

/** Unpinned runtime discovery observes foreign SQLite commits through the read worker. */
export async function resolveSelectedMacOSDesktopCodexAppPathCandidates(
  platform: NodeJS.Platform = process.platform,
  managedRoot?: string,
  options: CodexManagedRuntimeStateOptions = {},
): Promise<readonly MacOSDesktopCodexAppPathCandidate[]> {
  if (platform !== "darwin") {
    return [];
  }
  const managed = await readCodexManagedRuntimeSelection(managedRoot, options);
  return managed && managed.selection.appName !== "cli"
    ? [
        ...resolveMacOSDesktopCodexAppPathCandidatesForBundle(managed.appBundlePath),
        ...resolveMacOSDesktopCodexAppPathCandidates(platform),
      ]
    : resolveMacOSDesktopCodexAppPathCandidates(platform);
}

/** Historical owned generations remain valid sources for already-admitted clients. */
export function resolveMacOSDesktopCodexAppPathCandidateForBundle(
  appBundlePath: string,
  params: { platform?: NodeJS.Platform; managedRoot?: string } = {},
): MacOSDesktopCodexAppPathCandidate | undefined {
  if ((params.platform ?? process.platform) !== "darwin") {
    return undefined;
  }
  const standard = resolveMacOSDesktopCodexAppPathCandidates("darwin").some(
    (candidate) => candidate.appBundlePath === appBundlePath,
  );
  return standard || isCodexManagedRuntimeAppPath(appBundlePath, params.managedRoot)
    ? findMacOSDesktopCodexExecutable(appBundlePath)
    : undefined;
}

/** Artifacts follow the admitted command, including retained immutable generations. */
export function resolveMacOSDesktopCodexAppPathCandidatesForCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): {
  desktopCandidates: readonly MacOSDesktopCodexAppPathCandidate[];
  exactDesktopCandidate?: MacOSDesktopCodexAppPathCandidate;
} {
  const standard = resolveMacOSDesktopCodexAppPathCandidates(platform);
  const resolved = path.resolve(command);
  const bundle = resolveMacOSDesktopCodexAppBundlePath(resolved);
  const retained =
    bundle && resolveMacOSDesktopCodexAppPathCandidateForBundle(bundle, { platform });
  const exactDesktopCandidate =
    standard.find((candidate) => candidate.appServerCommandPath === resolved) ??
    (retained
      ? resolveMacOSDesktopCodexAppPathCandidatesForBundle(retained.appBundlePath).find(
          (candidate) => candidate.appServerCommandPath === resolved,
        )
      : undefined);
  return {
    exactDesktopCandidate,
    desktopCandidates: exactDesktopCandidate
      ? [
          exactDesktopCandidate,
          ...standard.filter((candidate) => candidate !== exactDesktopCandidate),
        ]
      : standard,
  };
}

export function resolveMacOSDesktopCodexAppServerCommandCandidates(
  platform: NodeJS.Platform = process.platform,
): string[] {
  return resolveMacOSDesktopCodexAppPathCandidates(platform).map(
    (candidate) => candidate.appServerCommandPath,
  );
}

export function resolveMacOSDesktopCodexBundledMarketplaceCandidates(
  platform: NodeJS.Platform = process.platform,
): string[] {
  return [
    ...new Set(
      resolveMacOSDesktopCodexAppPathCandidates(platform).map(
        (candidate) => candidate.bundledMarketplacePath,
      ),
    ),
  ];
}

export function resolveMacOSDesktopCodexComputerUseServiceAppCandidates(
  platform: NodeJS.Platform = process.platform,
  appServerCommand?: string,
): string[] {
  if (platform !== "darwin") {
    return [];
  }
  const orderedCandidates = appServerCommand
    ? resolveMacOSDesktopCodexAppPathCandidatesForCommand(appServerCommand, platform)
        .desktopCandidates
    : resolveMacOSDesktopCodexAppPathCandidates(platform);
  return [
    ...new Set(orderedCandidates.flatMap((candidate) => candidate.computerUseServiceAppPaths)),
  ];
}

export function resolveFirstExistingMacOSDesktopCodexBundledMarketplacePath(
  params: {
    platform?: NodeJS.Platform;
    candidates?: readonly string[];
    pathExists?: (filePath: string) => boolean;
  } = {},
): string | undefined {
  const candidates =
    params.candidates ?? resolveMacOSDesktopCodexBundledMarketplaceCandidates(params.platform);
  const pathExists = params.pathExists ?? existsSync;
  return candidates.find((candidate) => pathExists(candidate));
}
