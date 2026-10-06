/** Shared path candidates for Codex's macOS desktop app bundle. */
import { existsSync } from "node:fs";
import path from "node:path";

export type MacOSDesktopCodexAppPathCandidate = {
  appName: "ChatGPT.app" | "Codex.app";
  appBundlePath: string;
  appServerCommandPath: string;
  bundledMarketplacePath: string;
  computerUseServiceAppPaths: readonly string[];
};

const MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES: readonly MacOSDesktopCodexAppPathCandidate[] = (
  ["ChatGPT.app", "Codex.app"] as const
).flatMap((appName) => {
  const appBundlePath = `/Applications/${appName}`;
  const resources = `${appBundlePath}/Contents/Resources`;
  const computerUseServiceAppPaths = [
    `${resources}/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app`,
    `${resources}/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app`,
  ];
  if (appName === "Codex.app") {
    computerUseServiceAppPaths.reverse();
  }
  const candidate: MacOSDesktopCodexAppPathCandidate = {
    appName,
    appBundlePath,
    appServerCommandPath: `${resources}/codex`,
    bundledMarketplacePath: `${resources}/plugins/openai-bundled`,
    computerUseServiceAppPaths,
  };
  return [
    {
      ...candidate,
      appServerCommandPath: path.join(
        appBundlePath,
        "Contents",
        "Resources",
        "codex-cli",
        "CodexCLI.app",
        "Contents",
        "MacOS",
        "codex",
      ),
    },
    candidate,
  ];
});

export function resolveMacOSDesktopCodexAppPathCandidates(
  platform: NodeJS.Platform = process.platform,
): readonly MacOSDesktopCodexAppPathCandidate[] {
  return platform === "darwin" ? MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES : [];
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
  const candidates = resolveMacOSDesktopCodexAppPathCandidates(platform);
  const matchingCandidate = appServerCommand
    ? candidates.find(
        (candidate) =>
          path.resolve(candidate.appServerCommandPath) === path.resolve(appServerCommand),
      )
    : undefined;
  const orderedCandidates = matchingCandidate
    ? [matchingCandidate, ...candidates.filter((candidate) => candidate !== matchingCandidate)]
    : candidates;
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
