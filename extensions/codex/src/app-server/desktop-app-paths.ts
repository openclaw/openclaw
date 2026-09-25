/** Shared path candidates for Codex's macOS desktop app bundle. */
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { assertNoSymlinkParentsSync } from "openclaw/plugin-sdk/file-access-runtime";
import {
  isCodexManagedDesktopAppPath,
  readCodexManagedDesktopSelection,
  type CodexManagedDesktopStateOptions,
} from "./managed-desktop-installation.js";

export type MacOSDesktopCodexAppPathCandidate = {
  appName: "ChatGPT.app" | "Codex.app";
  appBundlePath: string;
  appServerCommandPath: string;
  bundledMarketplacePath: string;
  computerUseServiceAppPaths: readonly string[];
};

const MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES: readonly MacOSDesktopCodexAppPathCandidate[] = [
  {
    appName: "ChatGPT.app",
    appBundlePath: "/Applications/ChatGPT.app",
    appServerCommandPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    bundledMarketplacePath: "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled",
    computerUseServiceAppPaths: [
      "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app",
      "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app",
    ],
  },
  {
    appName: "Codex.app",
    appBundlePath: "/Applications/Codex.app",
    appServerCommandPath: "/Applications/Codex.app/Contents/Resources/codex",
    bundledMarketplacePath: "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled",
    computerUseServiceAppPaths: [
      "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app",
      "/Applications/Codex.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app",
    ],
  },
] as const;

/** Pure standard templates; no durable state is loaded during registration. */
export function resolveMacOSDesktopCodexAppPathCandidates(
  platform: NodeJS.Platform = process.platform,
): readonly MacOSDesktopCodexAppPathCandidate[] {
  return platform === "darwin" ? MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES : [];
}

/** Unpinned runtime discovery observes foreign SQLite commits through the read worker. */
export async function resolveSelectedMacOSDesktopCodexAppPathCandidates(
  platform: NodeJS.Platform = process.platform,
  managedRoot?: string,
  options: CodexManagedDesktopStateOptions = {},
): Promise<readonly MacOSDesktopCodexAppPathCandidate[]> {
  if (platform !== "darwin") {
    return [];
  }
  const managed = await readCodexManagedDesktopSelection(managedRoot, options);
  return managed
    ? [
        candidateAtPath(managed.selection.appName, managed.appBundlePath),
        ...MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES,
      ]
    : MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES;
}

/** Historical owned generations remain valid sources for already-admitted clients. */
export function resolveMacOSDesktopCodexAppPathCandidateForBundle(
  appBundlePath: string,
  params: { platform?: NodeJS.Platform; managedRoot?: string } = {},
): MacOSDesktopCodexAppPathCandidate | undefined {
  if ((params.platform ?? process.platform) !== "darwin") {
    return undefined;
  }
  const standard = MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES.find(
    (candidate) => candidate.appBundlePath === appBundlePath,
  );
  if (standard) {
    try {
      assertNoSymlinkParentsSync({
        rootDir: "/Applications",
        targetPath: path.dirname(standard.appServerCommandPath),
        requireDirectories: true,
        allowMissing: false,
      });
      return lstatSync(standard.appServerCommandPath).isFile() ? standard : undefined;
    } catch {
      return undefined;
    }
  }
  const template = MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES.find(
    (candidate) => candidate.appName === path.basename(appBundlePath),
  );
  return template && isCodexManagedDesktopAppPath(appBundlePath, params.managedRoot)
    ? candidateAtPath(template.appName, appBundlePath)
    : undefined;
}

function candidateAtPath(
  appName: "ChatGPT.app" | "Codex.app",
  appBundlePath: string,
): MacOSDesktopCodexAppPathCandidate {
  const standard = MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES.find(
    (candidate) => candidate.appName === appName,
  );
  if (!standard) {
    throw new Error("Unsupported Codex desktop app name.");
  }
  const relocate = (filePath: string) =>
    path.join(appBundlePath, path.relative(standard.appBundlePath, filePath));
  return {
    appName,
    appBundlePath,
    appServerCommandPath: relocate(standard.appServerCommandPath),
    bundledMarketplacePath: relocate(standard.bundledMarketplacePath),
    computerUseServiceAppPaths: standard.computerUseServiceAppPaths.map(relocate),
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
  return resolveMacOSDesktopCodexAppPathCandidates(platform).map(
    (candidate) => candidate.bundledMarketplacePath,
  );
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
    ? (candidates.find((candidate) => candidate.appServerCommandPath === appServerCommand) ??
      resolveMacOSDesktopCodexAppPathCandidateForBundle(
        path.dirname(path.dirname(path.dirname(appServerCommand))),
        { platform },
      ))
    : undefined;
  const matchesCommand = matchingCandidate?.appServerCommandPath === appServerCommand;
  const orderedCandidates =
    matchingCandidate && matchesCommand
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
