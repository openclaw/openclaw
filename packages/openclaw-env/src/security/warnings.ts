import os from "node:os";
import path from "node:path";
import type { ResolvedOpenClawEnvConfig } from "../config/load.js";

export type SafetyFindingKind = "hard_error" | "requires_override" | "requires_confirmation";

export type SafetyFinding = {
  kind: SafetyFindingKind;
  code: string;
  message: string;
  details?: string[];
};

export type SafetyEvaluation = {
  findings: SafetyFinding[];
  hardErrors: SafetyFinding[];
  requiresOverride: SafetyFinding[];
  requiresConfirmation: SafetyFinding[];
};

function isSameOrChild(childPath: string, parentPath: string): boolean {
  const rel = path.relative(parentPath, childPath);
  if (!rel) {
    return true;
  }
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function normalizeAbs(p: string): string {
  return path.resolve(p);
}

function resolveBannedMountDirs(homeDir: string, platform: NodeJS.Platform): string[] {
  const banned: string[] = [
    path.join(homeDir, ".ssh"),
    path.join(homeDir, ".aws"),
    path.join(homeDir, ".gnupg"),
    path.join(homeDir, ".config"),
  ];

  if (platform === "darwin") {
    banned.push(path.join(homeDir, "Library", "Safari"));
    banned.push(path.join(homeDir, "Library", "Application Support", "Google", "Chrome"));
    banned.push(path.join(homeDir, "Library", "Application Support", "Chromium"));
    banned.push(path.join(homeDir, "Library", "Application Support", "BraveSoftware"));
    banned.push(path.join(homeDir, "Library", "Application Support", "Microsoft Edge"));
    banned.push(path.join(homeDir, "Library", "Application Support", "Firefox"));
  } else if (platform === "linux") {
    banned.push(path.join(homeDir, ".mozilla"));
    banned.push(path.join(homeDir, ".config", "google-chrome"));
    banned.push(path.join(homeDir, ".config", "chromium"));
    banned.push(path.join(homeDir, ".config", "BraveSoftware"));
    banned.push(path.join(homeDir, ".config", "microsoft-edge"));
  } else if (platform === "win32") {
    // Best-effort. Many users run Docker via WSL2; paths are tricky. Keep it minimal.
    banned.push(path.join(homeDir, "AppData", "Roaming", "Mozilla", "Firefox"));
    banned.push(path.join(homeDir, "AppData", "Local", "Google", "Chrome", "User Data"));
    banned.push(path.join(homeDir, "AppData", "Local", "Microsoft", "Edge", "User Data"));
  }

  return banned.map(normalizeAbs);
}

export function evaluateSafety(cfg: ResolvedOpenClawEnvConfig): SafetyEvaluation {
  const findings: SafetyFinding[] = [];

  const homeDir = normalizeAbs(os.homedir());
  const bannedDirs = resolveBannedMountDirs(homeDir, process.platform);
  const dockerSock = normalizeAbs("/var/run/docker.sock");

  const allMounts: Array<{ hostPath: string; mode: "ro" | "rw"; label: string }> = [
    { hostPath: cfg.workspace.hostPath, mode: cfg.workspace.mode, label: "workspace" },
    ...cfg.workspace.writeAllowlist.map((m) => ({
      hostPath: m.hostPath,
      mode: "rw" as const,
      label: `workspace.write_allowlist:${m.subpath}`,
    })),
    ...cfg.mounts.map((m) => ({ hostPath: m.hostPath, mode: m.mode, label: m.container })),
  ];

  for (const mount of allMounts) {
    const hostPath = normalizeAbs(mount.hostPath);
    const mountRoot = normalizeAbs(path.parse(hostPath).root || "/");

    if (hostPath === dockerSock) {
      findings.push({
        kind: "hard_error",
        code: "mount_docker_sock",
        message: "Refusing to mount the Docker socket (/var/run/docker.sock). This is not allowed.",
      });
      continue;
    }

    if (hostPath === homeDir) {
      findings.push({
        kind: "requires_override",
        code: "mount_home",
        message: `Mounting your HOME directory is dangerous (${homeDir}).`,
        details: ["This can expose SSH keys, browser profiles, and other secrets."],
      });
    }

    if (hostPath === mountRoot) {
      findings.push({
        kind: "requires_override",
        code: "mount_root",
        message: `Mounting the filesystem root is dangerous (${mountRoot}).`,
      });
    }

    for (const banned of bannedDirs) {
      if (isSameOrChild(hostPath, banned)) {
        findings.push({
          kind: "requires_override",
          code: "mount_secret_dir",
          message: `Mounting sensitive path is denied-by-default: ${banned}`,
          details: [`Requested mount: ${hostPath}`],
        });
        break;
      }
    }
  }

  if (cfg.network.mode === "full") {
    const rwMounts = allMounts.filter((m) => m.mode === "rw").map((m) => m.hostPath);
    if (rwMounts.length > 0) {
      findings.push({
        kind: "requires_confirmation",
        code: "rw_mounts_with_full_network",
        message: "You have writable mounts with full network egress enabled.",
        details: [
          "This increases the risk of data exfiltration and repo poisoning if OpenClaw or a tool is compromised.",
          ...rwMounts.map((p) => `- rw: ${p}`),
        ],
      });
    }
  }

  const hardErrors = findings.filter((f) => f.kind === "hard_error");
  const requiresOverride = findings.filter((f) => f.kind === "requires_override");
  const requiresConfirmation = findings.filter((f) => f.kind === "requires_confirmation");

  return { findings, hardErrors, requiresOverride, requiresConfirmation };
}
