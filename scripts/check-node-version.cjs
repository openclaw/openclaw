#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

const minimum = { major: 22, minor: 19, patch: 0 };
const recommendedMajor = 24;

function commandExists(command) {
  const result = spawnSync("sh", ["-c", "command -v " + command + " >/dev/null 2>&1"], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || ""));
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isAtLeast(version, required) {
  if (!version) {
    return false;
  }
  if (version.major !== required.major) {
    return version.major > required.major;
  }
  if (version.minor !== required.minor) {
    return version.minor > required.minor;
  }
  return version.patch >= required.patch;
}

function run(command, args, options) {
  return spawnSync(command, args, Object.assign({ stdio: "inherit" }, options || {}));
}

function runShell(script) {
  return run("sh", ["-c", script]);
}

function canElevate() {
  if (process.platform === "win32") {
    return false;
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return true;
  }
  return commandExists("sudo");
}

function asRoot(command) {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return command;
  }
  return "sudo " + command;
}

function installNodeWithSystemPackageManager() {
  if (process.platform === "win32") {
    return false;
  }
  if (!canElevate()) {
    console.error(
      "[openclaw] Cannot auto-install Node.js because this user is not root and sudo is unavailable.",
    );
    return false;
  }

  if (commandExists("apt-get")) {
    return (
      runShell(
        [
          "set -e",
          asRoot("apt-get update"),
          asRoot("apt-get install -y ca-certificates curl gnupg"),
          "curl -fsSL https://deb.nodesource.com/setup_22.x | " + asRoot("bash -"),
          asRoot("apt-get remove -y npm libnode-dev nodejs-doc || true"),
          asRoot("apt-get install -y nodejs"),
        ].join("\n"),
      ).status === 0
    );
  }

  if (commandExists("dnf")) {
    return (
      runShell(
        [
          "set -e",
          asRoot("dnf install -y ca-certificates curl"),
          "curl -fsSL https://rpm.nodesource.com/setup_22.x | " + asRoot("bash -"),
          asRoot("dnf install -y nodejs"),
        ].join("\n"),
      ).status === 0
    );
  }

  if (commandExists("yum")) {
    return (
      runShell(
        [
          "set -e",
          asRoot("yum install -y ca-certificates curl"),
          "curl -fsSL https://rpm.nodesource.com/setup_22.x | " + asRoot("bash -"),
          asRoot("yum install -y nodejs"),
        ].join("\n"),
      ).status === 0
    );
  }

  if (commandExists("zypper")) {
    return (
      runShell(
        [
          "set -e",
          asRoot("zypper --non-interactive install ca-certificates curl"),
          "curl -fsSL https://rpm.nodesource.com/setup_22.x | " + asRoot("bash -"),
          asRoot("zypper --non-interactive install nodejs"),
        ].join("\n"),
      ).status === 0
    );
  }

  if (commandExists("apk")) {
    return (
      runShell(["set -e", asRoot("apk add --no-cache nodejs-current npm")].join("\n")).status === 0
    );
  }

  if (commandExists("pacman")) {
    return (
      runShell(["set -e", asRoot("pacman -Sy --noconfirm nodejs npm")].join("\n")).status === 0
    );
  }

  if (commandExists("brew")) {
    return run("brew", ["install", "node"]).status === 0;
  }

  console.error(
    "[openclaw] No supported package manager was found for automatic Node.js installation.",
  );
  return false;
}

function currentNodeVersionFromPath() {
  const result = spawnSync("node", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return null;
  }
  return parseVersion(result.stdout.trim());
}

function versionToString(version) {
  if (!version) {
    return "missing";
  }
  return [version.major, version.minor, version.patch].join(".");
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function firstPathCommand(command) {
  const result = spawnSync("sh", ["-c", "command -v " + command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim().split("\n")[0] || "";
}

function versionOfNodeBinary(path) {
  if (!path) {
    return null;
  }
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return parseVersion(result.stdout.trim());
}

function repairShadowedNodePath() {
  const systemNode = "/usr/bin/node";
  const systemVersion = versionOfNodeBinary(systemNode);
  if (!isAtLeast(systemVersion, minimum)) {
    return false;
  }

  const pathNode = firstPathCommand("node");
  if (!pathNode || pathNode === systemNode || isAtLeast(versionOfNodeBinary(pathNode), minimum)) {
    return false;
  }

  const stamp = String(Date.now());
  const nodeBackup = pathNode + ".openclaw-old-node-" + stamp;
  const commands = [
    "set -e",
    "if [ -e " +
      shellQuote(pathNode) +
      " ] || [ -L " +
      shellQuote(pathNode) +
      " ]; then " +
      asRoot("mv " + shellQuote(pathNode) + " " + shellQuote(nodeBackup)) +
      "; fi",
    asRoot("ln -sf " + shellQuote(systemNode) + " " + shellQuote(pathNode)),
  ];

  ["npm", "npx"].forEach(function (binary) {
    const pathBinary = firstPathCommand(binary);
    const systemBinary = "/usr/bin/" + binary;
    if (pathBinary && pathBinary !== systemBinary) {
      const backupBinary = pathBinary + ".openclaw-old-" + binary + "-" + stamp;
      commands.push(
        "if [ -e " +
          shellQuote(systemBinary) +
          " ] || [ -L " +
          shellQuote(systemBinary) +
          " ]; then " +
          "if [ -e " +
          shellQuote(pathBinary) +
          " ] || [ -L " +
          shellQuote(pathBinary) +
          " ]; then " +
          asRoot("mv " + shellQuote(pathBinary) + " " + shellQuote(backupBinary)) +
          "; fi; " +
          asRoot("ln -sf " + shellQuote(systemBinary) + " " + shellQuote(pathBinary)) +
          "; fi",
      );
    }
  });

  if (runShell(commands.join("\n")).status === 0) {
    console.error(
      "[openclaw] Repaired PATH so NodeSource Node.js is used before an older shadowing node binary.",
    );
    return true;
  }
  return false;
}

function shouldAutoInstall() {
  if (
    process.env.OPENCLAW_AUTO_INSTALL_NODE === "0" ||
    process.env.OPENCLAW_SKIP_NODE_AUTO_INSTALL === "1"
  ) {
    return false;
  }
  const lifecycle = process.env.npm_lifecycle_event || "";
  return lifecycle === "preinstall" || process.env.OPENCLAW_AUTO_INSTALL_NODE === "1";
}

function envTruthy(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] || "");
}

function isGlobalNpmLifecycle() {
  return envTruthy("npm_config_global") || envTruthy("NPM_CONFIG_GLOBAL");
}

function existingOpenClawBinary() {
  if (process.platform === "win32") {
    return "";
  }
  return firstPathCommand("openclaw");
}

function failClosedOnAccidentalExistingInstallUpgrade() {
  const lifecycle = process.env.npm_lifecycle_event || "";
  if (lifecycle !== "preinstall" || !isGlobalNpmLifecycle()) {
    return;
  }
  if (process.env.ZORG_INSTALL_MODE === "existing" || envTruthy("ZORG_ALLOW_EXISTING_UPGRADE")) {
    return;
  }
  const existing = existingOpenClawBinary();
  if (!existing) {
    return;
  }
  console.error("[openclaw] Existing host OpenClaw binary detected: " + existing);
  console.error(
    "[openclaw] Refusing to treat this direct GitHub npm command as a first-run install because it would upgrade an existing host install.",
  );
  console.error(
    "[openclaw] For a clean first-run install, remove or isolate the existing host install first, then install OpenClaw before applying Zorg MemoryDB and LAN command chat.",
  );
  console.error(
    "[openclaw] To intentionally repair an existing host install, rerun with ZORG_INSTALL_MODE=existing ZORG_ALLOW_EXISTING_UPGRADE=1.",
  );
  process.exit(3);
}

function printManualInstallHelp() {
  console.error(
    [
      "[openclaw] Node.js " + process.version + " is too old for this package.",
      "[openclaw] Required: Node.js >=22.19.0; recommended: Node.js " + recommendedMajor + ".",
      "[openclaw] On fresh Linux hosts, the direct npm install now tries to upgrade Node automatically during preinstall.",
      "[openclaw] If auto-repair is unavailable on this OS/user, run the Zorg MemoryDB installer first:",
      "[openclaw]   curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/StefRush2099/Zorg_MemoryDB/main/scripts/install.sh | bash",
      "[openclaw] Then rerun the npm install after node --version reports v22.19.0 or newer.",
    ].join("\n"),
  );
}

function printRepairedRuntimeRetryHelp(repaired) {
  const npm = firstPathCommand("npm") || "npm";
  console.error(
    [
      "[openclaw] Node.js prerequisite repaired; node on PATH is now " +
        versionToString(repaired) +
        ".",
      "[openclaw] The current npm process was started under " +
        process.version +
        ", so it cannot safely continue this install.",
      "[openclaw] Rerun the same install command now that node/npm have been repaired:",
      "[openclaw]   " +
        npm +
        " install -g --install-links=true git+https://github.com/StefRush2099/Zorg_MemoryDB.git",
    ].join("\n"),
  );
}

const current = parseVersion(process.version);
failClosedOnAccidentalExistingInstallUpgrade();
if (!isAtLeast(current, minimum)) {
  if (shouldAutoInstall()) {
    console.error(
      "[openclaw] Node.js " +
        process.version +
        " is too old; attempting automatic Node.js >=22.19.0 install.",
    );
    if (installNodeWithSystemPackageManager()) {
      repairShadowedNodePath();
      const repaired = currentNodeVersionFromPath();
      if (isAtLeast(repaired, minimum)) {
        printRepairedRuntimeRetryHelp(repaired);
        process.exit(86);
      }
      console.error(
        "[openclaw] Automatic Node.js install completed, but node on PATH is still below v22.19.0.",
      );
    }
  }
  printManualInstallHelp();
  process.exit(1);
}
