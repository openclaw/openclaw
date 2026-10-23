import { execFileSync } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { resolveMxcLauncherPath } from "./plugin-root.js";
import { buildLauncherEnv } from "./windows-env.js";

const MxcLauncherProbeSchema = z.object({
  probe: z.object({
    tier: z.enum(["base-container", "appcontainer-bfs", "appcontainer-dacl"]).optional(),
    warnings: z.array(z.string()).default([]),
    error: z.string().optional(),
  }),
});

function resolveWindowsSystemExecutable(name: string): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  return path.win32.join(systemRoot || "C:\\Windows", "System32", name);
}

// The probe runs in the launcher, with the same pinned `mxc_ffi` that executes
// commands. A probe can succeed without selecting a tier; only a selected and
// admitted tier means this host can run MXC sandboxes.
function probeMxcIsolationTier(nativeEnv: Record<string, string>): {
  tier: string;
  warnings: string[];
} {
  const notReady = (reason: string, cause?: unknown) =>
    new Error(
      `[mxc] MXC Windows ProcessContainer sandbox is not ready: ${reason}. ` +
        `The plugin probes the host through @microsoft/mxc-sdk 1.0 with the native ` +
        `components in ${nativeEnv.MXC_FFI_DIR}. If mxcBinaryPath is set, it must point ` +
        `to an MXC 1.0 release layout; otherwise unset ` +
        `plugins.entries.mxc.config.mxcBinaryPath and restart the Gateway to use the ` +
        `bundled SDK components.`,
      cause === undefined ? undefined : { cause },
    );
  let output: string;
  try {
    output = execFileSync(process.execPath, [resolveMxcLauncherPath(), "--probe"], {
      encoding: "utf-8",
      env: buildLauncherEnv(nativeEnv),
      stdio: "pipe",
      timeout: 30_000,
      windowsHide: true,
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message.trim()}` : "";
    throw notReady(`the MXC host check failed${detail}`, error);
  }
  let probe: unknown;
  try {
    probe = JSON.parse(output);
  } catch (error) {
    throw notReady("the MXC host check did not return JSON", error);
  }
  const parsed = MxcLauncherProbeSchema.safeParse(probe);
  if (!parsed.success) {
    throw notReady("the MXC host check returned an unexpected result", parsed.error);
  }
  const { probe: result } = parsed.data;
  if (!result.tier) {
    const reason = result.error || "the check reported no isolation tier";
    throw notReady(`MXC cannot select an isolation tier on this host (${reason})`);
  }
  return { tier: result.tier, warnings: result.warnings };
}

// AppContainer processes need directory-traversal/list rights on the system
// drive root (C:\) to enumerate directories inside the sandbox.
// `wxc-host-prep prepare-system-drive` adds ACEs for the well-known
// ALL APPLICATION PACKAGES (S-1-15-2-1) and ALL RESTRICTED APPLICATION PACKAGES
// (S-1-15-2-2) SIDs. Without this, directory listing (e.g. `dir`) inside the
// sandbox fails with "Access is denied". This is advisory: the sandbox still
// runs basic cmd.exe read/write workloads without it, so a missing grant warns
// rather than blocking activation.
function isSystemDrivePrepared(): boolean {
  const systemDrive = process.env.SystemDrive || "C:";
  let output: string;
  try {
    output = execFileSync(resolveWindowsSystemExecutable("icacls.exe"), [`${systemDrive}\\`], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    // If icacls itself fails, assume prepared rather than emitting a spurious
    // warning on a host we cannot probe.
    return true;
  }
  // Look for the well-known ALL APPLICATION PACKAGES SID (S-1-15-2-1) or its
  // display name. Both forms can appear depending on OS locale/version.
  return output.includes("S-1-15-2-1") || output.includes("APPLICATION PACKAGES");
}

function systemDrivePrepWarning(systemDrive: string): string {
  return (
    `[mxc] MXC sandbox host preparation incomplete: the system drive root (${systemDrive}\\) ` +
    `does not grant directory access to AppContainer processes, so directory listing ` +
    `(e.g. \`dir\`) inside the sandbox will fail with "Access is denied". Basic read/write ` +
    `workloads still run.\n` +
    `Fix (one-time, elevated): wxc-host-prep prepare-system-drive (ships with @microsoft/mxc-sdk).`
  );
}

/**
 * Emits an advisory warning when the system drive is not prepared for
 * AppContainer directory access. Non-fatal: the sandbox still activates.
 */
export function warnMxcHostPrepIfNeeded(): void {
  if (process.platform !== "win32") {
    return;
  }
  if (!isSystemDrivePrepared()) {
    console.warn(systemDrivePrepWarning(process.env.SystemDrive || "C:"));
  }
}

// SDK 0.8 requested a least-privilege AppContainer (LPAC); SDK 1.0 cannot, so
// the AppContainer tiers now run a regular AppContainer. base-container has no
// LPAC token in either version and is unaffected.
function appContainerTierNotice(tier: string): string {
  return (
    `[mxc] MXC selected the ${tier} isolation tier. With MXC SDK 1.0 this tier runs ` +
    `sandboxed commands in a regular AppContainer, not a least-privilege AppContainer ` +
    `(LPAC), so they can reach resources granted to ALL APPLICATION PACKAGES.`
  );
}

// @microsoft/mxc-sdk 1.0.0 refuses non-PTY commands on Windows outside this Node
// range (dist/bindings/native-stdio.js), which is narrower than OpenClaw's own
// engines range. The launcher runs on the Gateway's Node, so check it once here
// instead of failing every command. Recheck on each SDK bump.
const WINDOWS_NODE_REQUIREMENT = "24.21.0 or newer within Node.js 24, or 26.8.0 or newer";

function supportsMxcWindowsNode(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return (major === 24 && minor >= 21) || (major === 26 && minor >= 8) || major > 26;
}

/**
 * Fails plugin activation unless the Gateway's Node.js meets MXC SDK 1.0's
 * Windows requirement and MXC's host probe, run with the pinned native
 * components, selects an isolation tier. The AppContainer-tier isolation notice
 * and the probe's degradation warnings are reported but do not block activation.
 */
export function assertMxcReadiness(params: { nativeEnv: Record<string, string> }): void {
  if (process.platform !== "win32") {
    return;
  }
  if (!supportsMxcWindowsNode(process.versions.node)) {
    throw new Error(
      `[mxc] MXC Windows ProcessContainer sandbox is not ready: @microsoft/mxc-sdk 1.0 ` +
        `requires Node.js ${WINDOWS_NODE_REQUIREMENT} on Windows, and the Gateway runs ` +
        `Node.js ${process.versions.node}. Upgrade Node.js and restart the Gateway.`,
    );
  }
  const probe = probeMxcIsolationTier(params.nativeEnv);
  if (probe.tier !== "base-container") {
    console.info(appContainerTierNotice(probe.tier));
  }
  if (probe.warnings.length > 0) {
    console.warn(
      `[mxc] MXC sandbox is using the ${probe.tier} isolation tier: ${probe.warnings.join("; ")}`,
    );
  }
}
