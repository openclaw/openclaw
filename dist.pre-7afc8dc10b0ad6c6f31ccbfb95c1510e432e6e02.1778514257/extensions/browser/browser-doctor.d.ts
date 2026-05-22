import { i as OpenClawConfig } from "../../types.openclaw-C9E_zZnO.js";
import { n as note } from "../../cli-runtime-C49ZdK3M.js";
import { i as resolveBrowserExecutableForPlatform } from "../../chrome.executables-D5x1U11z.js";
//#region extensions/browser/src/doctor-browser.d.ts
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
}): Promise<void>;
//#endregion
export { noteChromeMcpBrowserReadiness };