import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertCurrent,
  CLAUDE_CODE_PACKAGE_NAME as PACKAGE,
  commandResolutionProblem,
  commandSucceeded,
  executableExists,
  homeDirectory,
  probeClaudeVersion,
  resolveCommand,
  runCommand,
} from "./cli-installation-command.js";
import {
  CLAUDE_INSTALLATION_OWNER_MESSAGE,
  isClaudeInstallationOwnedByCurrentUser,
} from "./cli-installation-ownership.js";
import type {
  ClaudeCommandContext,
  ClaudeInstallation,
  ClaudeInstallationResult,
  ClaudeInstallationUpdateResult,
} from "./cli-installation.types.js";
import { parseClaudeCodeVersion } from "./cli-shared.js";
export { probeClaudeVersion } from "./cli-installation-command.js";
export type {
  ClaudeCommandContext,
  ClaudeInstallation,
  ClaudeInstallationResult,
  ClaudeInstallationUpdateResult,
} from "./cli-installation.types.js";

function unsupported(
  reason: Extract<ClaudeInstallationResult, { status: "unsupported" }>["reason"],
  message: string,
): ClaudeInstallationResult {
  return { status: "unsupported", reason, message };
}

async function realpath(candidate: string): Promise<string | undefined> {
  return fs.realpath(candidate).catch(() => undefined);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function supported(
  stableCommand: string,
  executable: string,
  details: Pick<ClaudeInstallation, "kind" | "ownerRoot" | "managerCommand" | "updateArgv">,
): Promise<ClaudeInstallationResult> {
  if (!(await isClaudeInstallationOwnedByCurrentUser({ stableCommand, executable, ...details }))) {
    return unsupported("unproven-owner", CLAUDE_INSTALLATION_OWNER_MESSAGE);
  }
  return {
    status: "supported",
    installation: {
      ...details,
      key: JSON.stringify([details.kind, details.ownerRoot]),
      stableCommand,
      executable,
    },
  };
}

/** Inspect only the selected installation; another Claude on PATH cannot repair it. */
export async function detectClaudeInstallation(
  context: ClaudeCommandContext,
): Promise<ClaudeInstallationResult> {
  assertCurrent(context);
  if (!["darwin", "linux"].includes(process.platform)) {
    return unsupported(
      "unsupported-manager",
      "Automatic Claude updates currently support macOS and Linux. Update the configured Claude executable through its installer, then refresh models.",
    );
  }
  const resolutionProblem = commandResolutionProblem(context);
  if (resolutionProblem) {
    return unsupported("unproven-owner", resolutionProblem);
  }
  if (context.env.XDG_DATA_HOME && !path.isAbsolute(context.env.XDG_DATA_HOME)) {
    return unsupported(
      "unproven-owner",
      "Claude maintenance requires an absolute XDG_DATA_HOME. Correct it or unset it to use the native installation's default data directory.",
    );
  }
  const stableCommand = await resolveCommand(context);
  if (!stableCommand) {
    return unsupported(
      "missing",
      "The configured Claude executable is missing. Install Claude Code or correct its command path.",
    );
  }
  const executable = await realpath(stableCommand);
  if (!executable) {
    return unsupported(
      "unproven-owner",
      "The configured Claude executable could not be resolved. Repair its launcher before updating.",
    );
  }
  if (
    executable.includes(`${path.sep}Application Support${path.sep}Claude${path.sep}`) ||
    executable.includes(`${path.sep}Claude.app${path.sep}`)
  ) {
    return unsupported(
      "desktop-managed",
      "This Claude executable belongs to Claude Desktop. Update Claude Desktop, then refresh models.",
    );
  }
  const home = homeDirectory(context);
  if (!home) {
    return unsupported(
      "unproven-owner",
      "Claude maintenance requires the configured host home directory.",
    );
  }
  const nativeRoot = await realpath(
    path.join(
      context.env.XDG_DATA_HOME || path.join(home, ".local", "share"),
      "claude",
      "versions",
    ),
  );
  if (nativeRoot && inside(nativeRoot, executable)) {
    if (
      path.dirname(executable) !== nativeRoot ||
      !/^\d+\.\d+\.\d+$/u.test(path.basename(executable))
    ) {
      return unsupported(
        "unproven-owner",
        "Claude's launcher does not target a native installer version file. Repair the native launcher before updating automatically.",
      );
    }
    const launcher = path.join(home, ".local", "bin", "claude");
    if (
      path.resolve(stableCommand) !== path.resolve(launcher) ||
      (await realpath(launcher)) !== executable
    ) {
      return unsupported(
        "pinned-command",
        "Claude is pinned to a native version. Configure the native ~/.local/bin/claude launcher before updating automatically.",
      );
    }
    if (!(await fs.lstat(launcher)).isSymbolicLink()) {
      return unsupported(
        "custom-wrapper",
        "Claude's native launcher is custom-managed. Update it through its owner, then refresh models.",
      );
    }
    return supported(stableCommand, executable, {
      kind: "native",
      ownerRoot: nativeRoot,
      managerCommand: stableCommand,
      updateArgv: ["update"],
    });
  }
  const brewMatch = /^(.*)\/Caskroom\/(claude-code(?:@latest)?)\/([^/]+)\/claude$/.exec(executable);
  if (brewMatch) {
    const [, prefix, cask, version] = brewMatch;
    if (!prefix || !path.isAbsolute(prefix)) {
      return unsupported(
        "unproven-owner",
        "Claude's Homebrew prefix could not be established. Repair its Homebrew installation before updating.",
      );
    }
    if (path.resolve(stableCommand) !== path.join(prefix!, "bin", "claude")) {
      return unsupported(
        "pinned-command",
        "Claude is pinned to a Homebrew cask version. Configure Homebrew's bin/claude launcher before updating automatically.",
      );
    }
    const managerCommand = path.join(prefix!, "bin", "brew");
    const ownerRoot = path.join(prefix!, "Caskroom", cask!);
    if (
      !(await isClaudeInstallationOwnedByCurrentUser({
        stableCommand,
        executable,
        ownerRoot,
        managerCommand,
      }))
    ) {
      return unsupported("unproven-owner", CLAUDE_INSTALLATION_OWNER_MESSAGE);
    }
    if (await executableExists(managerCommand)) {
      const root = await runCommand(context, managerCommand, ["--caskroom", cask!]);
      const installed = await runCommand(context, managerCommand, [
        "list",
        "--cask",
        "--versions",
        cask!,
      ]);
      if (
        commandSucceeded(root) &&
        (await realpath(root.stdout.trim())) === (await realpath(ownerRoot)) &&
        commandSucceeded(installed) &&
        installed.stdout
          .trim()
          .split(/\r?\n/u)
          .some((line) => {
            const [installedCask, ...versions] = line.trim().split(/\s+/u);
            return installedCask === cask && versions.includes(version!);
          })
      ) {
        return supported(stableCommand, executable, {
          kind: "homebrew",
          ownerRoot,
          managerCommand,
          updateArgv: ["upgrade", "--cask", cask!],
        });
      }
    }
    return unsupported(
      "unproven-owner",
      "Homebrew ownership of the selected Claude installation could not be verified. Update its exact cask manually, then refresh models.",
    );
  }
  const packageSuffix = `${path.sep}node_modules${path.sep}@anthropic-ai${path.sep}claude-code${path.sep}`;
  const packageIndex = executable.lastIndexOf(packageSuffix);
  if (packageIndex >= 0) {
    const globalRoot = executable.slice(0, packageIndex + `${path.sep}node_modules`.length);
    const packageRoot = path.join(globalRoot, "@anthropic-ai", "claude-code");
    const parent = path.dirname(globalRoot);
    const prefix = path.basename(parent) === "lib" ? path.dirname(parent) : undefined;
    if (
      !prefix ||
      executable.includes(`${path.sep}.pnpm${path.sep}`) ||
      executable.includes(`${path.sep}.bun${path.sep}`) ||
      (await realpath(path.join(globalRoot, ".modules.yaml")))
    ) {
      return unsupported(
        "unsupported-manager",
        "This Claude package is not a verified npm global installation. Update it with its owning package manager, then refresh models.",
      );
    }
    const metadata = await fs
      .readFile(path.join(packageRoot, "package.json"), "utf8")
      .then((raw) => {
        const parsed: unknown = JSON.parse(raw);
        return isRecord(parsed) ? parsed : undefined;
      })
      .catch(() => undefined);
    const bin =
      typeof metadata?.bin === "string"
        ? metadata.bin
        : isRecord(metadata?.bin)
          ? metadata.bin.claude
          : undefined;
    if (
      metadata?.name !== PACKAGE ||
      typeof bin !== "string" ||
      (await realpath(path.join(packageRoot, bin))) !== executable
    ) {
      return unsupported(
        "unproven-owner",
        "Claude's npm package does not own the selected entrypoint. Repair the package launcher before updating.",
      );
    }
    const expectedLauncher = path.join(prefix, "bin", "claude");
    if (
      path.resolve(stableCommand) !== path.resolve(expectedLauncher) ||
      (await realpath(expectedLauncher)) !== executable
    ) {
      return unsupported(
        "pinned-command",
        "Claude is pinned to an npm package file. Configure the npm global launcher before updating automatically.",
      );
    }
    const managerCommand = await resolveCommand(context, path.join(prefix, "bin", "npm"));
    if (managerCommand) {
      if (
        !(await isClaudeInstallationOwnedByCurrentUser({
          stableCommand,
          executable,
          ownerRoot: prefix,
          managerCommand,
        }))
      ) {
        return unsupported("unproven-owner", CLAUDE_INSTALLATION_OWNER_MESSAGE);
      }
      const owner = await runCommand(context, managerCommand, ["prefix", "--global"]);
      const version = await runCommand(context, managerCommand, ["--version"]);
      const npmVersion = parseClaudeCodeVersion(version.stdout);
      if (
        commandSucceeded(owner) &&
        (await realpath(owner.stdout.trim())) === (await realpath(prefix)) &&
        commandSucceeded(version) &&
        npmVersion
      ) {
        const [major, minor] = npmVersion.split(".").map(Number);
        return supported(stableCommand, executable, {
          kind: "npm",
          ownerRoot: prefix,
          managerCommand,
          updateArgv: [
            "install",
            "--global",
            "--prefix",
            prefix,
            `${PACKAGE}@latest`,
            "--no-audit",
            "--no-fund",
            ...(major! > 11 || (major === 11 && minor! >= 16)
              ? [`--allow-scripts=${PACKAGE}`]
              : []),
          ],
        });
      }
    }
    return unsupported(
      "unproven-owner",
      "The npm command does not own Claude's global prefix. Update the selected npm installation manually, then refresh models.",
    );
  }
  return unsupported(
    "custom-wrapper",
    "The selected Claude launcher has no supported installation owner. Update it through its installer, then refresh models.",
  );
}

export async function updateClaudeInstallation(
  context: ClaudeCommandContext,
  expected: ClaudeInstallation,
): Promise<ClaudeInstallationUpdateResult> {
  const current = await detectClaudeInstallation(context);
  if (
    current.status !== "supported" ||
    current.installation.key !== expected.key ||
    current.installation.stableCommand !== expected.stableCommand ||
    current.installation.managerCommand !== expected.managerCommand ||
    !(await isClaudeInstallationOwnedByCurrentUser(current.installation))
  ) {
    return {
      status: "failed",
      reason: "owner-changed",
      message:
        current.status === "unsupported"
          ? current.message
          : "Claude's installation ownership changed while its update was prepared. Update through the installing user, then refresh models.",
    };
  }
  const result = await runCommand(
    current.installation.kind === "homebrew"
      ? { ...context, env: { ...context.env, HOMEBREW_NO_INSTALL_CLEANUP: "1" } }
      : context,
    current.installation.managerCommand,
    current.installation.updateArgv,
    true,
  );
  assertCurrent(context);
  if (!commandSucceeded(result)) {
    return {
      status: "failed",
      reason: "update-failed",
      message:
        "Claude's installer did not complete successfully. Update its installation manually, then refresh models.",
    };
  }
  const next = await detectClaudeInstallation(context);
  const version = await probeClaudeVersion(context);
  if (
    next.status !== "supported" ||
    next.installation.key !== expected.key ||
    next.installation.stableCommand !== expected.stableCommand ||
    !version
  ) {
    return {
      status: "failed",
      reason: "verification-failed",
      message:
        "Claude's updated launcher could not be verified. Repair the selected installation, then refresh models.",
    };
  }
  return { status: "updated", installation: next.installation, version };
}
