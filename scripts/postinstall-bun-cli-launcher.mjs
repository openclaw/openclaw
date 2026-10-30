import { isAbsolute, join } from "node:path";
import {
  getBunCliLauncherPathIssue,
  inspectBunCliLauncher,
  installBunCliLauncher,
  resolveBunGlobalBinDir,
} from "./lib/bun-cli-launcher.mjs";
import {
  detectLifecyclePackageManager,
  probePackageCliNodeRuntime,
} from "./preinstall-package-manager-warning.mjs";

/** Complete only the Bun global link that this lifecycle already owns.
 * @param {{packageRoot: string, env?: NodeJS.ProcessEnv, bunVersion?: string}} params
 */
export function installPackageBunCliLauncher(params) {
  const env = params.env ?? process.env;
  const bunPath = env.OPENCLAW_PACKAGE_BUN_LAUNCHER?.trim();
  if (
    process.platform === "win32" ||
    !(params.bunVersion ?? process.versions.bun) ||
    detectLifecyclePackageManager(env) !== "bun" ||
    !bunPath ||
    !isAbsolute(bunPath)
  ) {
    return;
  }
  // Reuse preinstall's persistent-Node check; a Bun install with Node keeps its bin.
  if (!probePackageCliNodeRuntime({ env, cwd: params.packageRoot })?.bunVersion) {
    return;
  }
  if (
    getBunCliLauncherPathIssue({ bunPath, entryPath: join(params.packageRoot, "openclaw.mjs") })
  ) {
    return;
  }
  const binDir = resolveBunGlobalBinDir({ bunPath, env, cwd: params.packageRoot });
  const target = { packageRoot: params.packageRoot, bunPath, binDir };
  const inspected = inspectBunCliLauncher(target);
  // A global symlink to this package is proof of ownership. Local dependency
  // installs and non-inherited --config paths cannot claim an absent global bin.
  if (inspected.state === "missing" || inspected.state === "conflict") {
    return;
  }
  installBunCliLauncher(target);
}
