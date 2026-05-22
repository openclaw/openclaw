import { i as OpenClawConfig } from "../../types.openclaw-CoVv5VQR.js";
import { n as note } from "../../cli-runtime-C_m-O71H.js";
import { i as resolveBrowserExecutableForPlatform } from "../../chrome.executables-C-JOTN56.js";
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