/** Official executable layouts and their app-owned Computer Use resources. */
import { lstatSync } from "node:fs";
import path from "node:path";
import { assertNoSymlinkParentsSync } from "openclaw/plugin-sdk/file-access-runtime";

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

/** Pure standard templates; no durable state is loaded during registration. */
export function resolveMacOSDesktopCodexAppPathCandidates(
  platform: NodeJS.Platform = process.platform,
): readonly MacOSDesktopCodexAppPathCandidate[] {
  return platform === "darwin" ? MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES : [];
}

export function resolveMacOSDesktopCodexAppPathCandidatesForBundle(
  appBundlePath: string,
): readonly MacOSDesktopCodexAppPathCandidate[] {
  return MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES.filter(
    (candidate) => candidate.appName === path.basename(appBundlePath),
  ).map((candidate) => {
    const relocate = (value: string) =>
      path.join(appBundlePath, path.relative(candidate.appBundlePath, value));
    // Relocation must not mutate the shared standard templates.
    return Object.assign({}, candidate, {
      appBundlePath,
      appServerCommandPath: relocate(candidate.appServerCommandPath),
      bundledMarketplacePath: relocate(candidate.bundledMarketplacePath),
      computerUseServiceAppPaths: candidate.computerUseServiceAppPaths.map(relocate),
    });
  });
}

/** Both signed layouts resolve back to the same app-owned resources. */
export function resolveMacOSDesktopCodexAppBundlePath(command: string): string | undefined {
  for (const candidate of MACOS_DESKTOP_CODEX_APP_PATH_CANDIDATES) {
    const suffix =
      path.sep + path.relative(candidate.appBundlePath, candidate.appServerCommandPath);
    if (command.endsWith(suffix)) {
      return command.slice(0, -suffix.length);
    }
  }
  return undefined;
}

/** Candidate inspection never follows executable or directory aliases. */
export function findMacOSDesktopCodexExecutable(
  appBundlePath: string,
): MacOSDesktopCodexAppPathCandidate | undefined {
  return resolveMacOSDesktopCodexAppPathCandidatesForBundle(appBundlePath).find((candidate) => {
    try {
      assertNoSymlinkParentsSync({
        rootDir: appBundlePath,
        targetPath: path.dirname(candidate.appServerCommandPath),
        requireDirectories: true,
        allowMissing: false,
      });
      const stat = lstatSync(candidate.appServerCommandPath);
      return stat.isFile() && (stat.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
}
