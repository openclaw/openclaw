import { i as OpenClawConfig } from "../../types.openclaw-DPnlcagS.js";
import { n as note } from "../../cli-runtime-BfykO1HI.js";
import { i as resolveBrowserExecutableForPlatform } from "../../chrome.executables-tE1-96PI.js";
//#region extensions/browser/src/doctor-browser.d.ts
type LegacyClawdBrowserProfileResidue = {
  legacyProfileDir: string;
  legacyUserDataDir: string;
  canonicalUserDataDir: string;
};
type BrowserDoctorFilesystemDeps = {
  configDir?: string;
  pathExists?: (targetPath: string) => boolean;
  movePathToTrash?: (targetPath: string) => Promise<string>;
};
declare function detectLegacyClawdBrowserProfileResidue(cfg: OpenClawConfig, deps?: BrowserDoctorFilesystemDeps): LegacyClawdBrowserProfileResidue | null;
declare function noteChromeMcpBrowserReadiness(cfg: OpenClawConfig, deps?: {
  platform?: NodeJS.Platform;
  noteFn?: typeof note;
  env?: NodeJS.ProcessEnv;
  getUid?: () => number;
  resolveManagedExecutable?: typeof resolveBrowserExecutableForPlatform;
  resolveChromeExecutable?: (platform: NodeJS.Platform) => {
    path: string;
  } | null;
  readVersion?: (executablePath: string) => string | null;
  configDir?: string;
  pathExists?: (targetPath: string) => boolean;
}): Promise<void>;
declare function maybeArchiveLegacyClawdBrowserProfileResidue(cfg: OpenClawConfig, deps?: BrowserDoctorFilesystemDeps): Promise<{
  changes: string[];
  warnings: string[];
}>;
//#endregion
export { type LegacyClawdBrowserProfileResidue, detectLegacyClawdBrowserProfileResidue, maybeArchiveLegacyClawdBrowserProfileResidue, noteChromeMcpBrowserReadiness };