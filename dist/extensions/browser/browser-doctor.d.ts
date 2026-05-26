import { i as OpenClawConfig } from "../../types.openclaw-BLF4DJTX.js";
import { n as note } from "../../cli-runtime-DPtJ18X5.js";
import { i as resolveBrowserExecutableForPlatform } from "../../chrome.executables-sU9yfW0S.js";
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