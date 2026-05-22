import { i as OpenClawConfig } from "../../types.openclaw-D8bJSZjd.js";
import { n as note } from "../../cli-runtime-B0KEG2Rb.js";
import { i as resolveBrowserExecutableForPlatform } from "../../chrome.executables-BunNnKOR.js";
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