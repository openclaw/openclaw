/** Shared path candidates for Codex's macOS desktop app bundle. */
import { existsSync } from "node:fs";
import path from "node:path";

type MacOSDesktopCodexAppPathCandidate = {
  appName: "ChatGPT.app" | "Codex.app";
  appBundlePath: string;
  appServerCommandPath: string;
  bundledMarketplacePath: string;
  computerUseServiceAppPath: string;
};

const MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES: readonly MacOSDesktopCodexAppPathCandidate[] = [
  {
    appName: "ChatGPT.app",
    appBundlePath: "/Applications/ChatGPT.app",
    appServerCommandPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    bundledMarketplacePath: "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled",
    computerUseServiceAppPath:
      "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app",
  },
  {
    appName: "Codex.app",
    appBundlePath: "/Applications/Codex.app",
    appServerCommandPath: "/Applications/Codex.app/Contents/Resources/codex",
    bundledMarketplacePath: "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled",
    computerUseServiceAppPath:
      "/Applications/Codex.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app",
  },
] as const;

export function resolveMacOSDesktopCodexBundledMarketplaceCandidates(
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === "darwin"
    ? MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES.map((candidate) => candidate.bundledMarketplacePath)
    : [];
}

export function resolveMacOSDesktopCodexComputerUseServiceAppCandidates(
  platform: NodeJS.Platform = process.platform,
  appServerCommand?: string,
): string[] {
  if (platform !== "darwin") {
    return [];
  }
  const matchingCandidate = appServerCommand
    ? MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES.find(
        (candidate) =>
          path.resolve(candidate.appServerCommandPath) === path.resolve(appServerCommand),
      )
    : undefined;
  const orderedCandidates = matchingCandidate
    ? [
        matchingCandidate,
        ...MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES.filter(
          (candidate) => candidate !== matchingCandidate,
        ),
      ]
    : MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES;
  return orderedCandidates.map((candidate) => candidate.computerUseServiceAppPath);
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
