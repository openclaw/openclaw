import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

function listContractTestFiles(rootDir = "src/channels/plugins/contracts") {
  if (!existsSync(rootDir)) {
    return [];
  }

  return readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => join(rootDir, entry.name).replaceAll("\\", "/"))
    .toSorted((a, b) => a.localeCompare(b));
}

export function createChannelContractTestShards() {
  const rootDir = "src/channels/plugins/contracts";
  const groups = {
    "checks-fast-contracts-channels-registry-a": [],
    "checks-fast-contracts-channels-registry-b": [],
    "checks-fast-contracts-channels-core-a": [],
    "checks-fast-contracts-channels-core-b": [],
    "checks-fast-contracts-channels-extensions": [],
  };
  const pushBalanced = (firstKey, secondKey, file) => {
    const target = groups[firstKey].length <= groups[secondKey].length ? firstKey : secondKey;
    groups[target].push(file);
  };

  for (const file of listContractTestFiles(rootDir)) {
    const name = relative(rootDir, file).replaceAll("\\", "/");
    if (name.startsWith("plugins-core-extension.")) {
      groups["checks-fast-contracts-channels-extensions"].push(file);
    } else if (name.startsWith("plugins-core.") || name.startsWith("plugin.")) {
      pushBalanced(
        "checks-fast-contracts-channels-core-a",
        "checks-fast-contracts-channels-core-b",
        file,
      );
    } else {
      pushBalanced(
        "checks-fast-contracts-channels-registry-a",
        "checks-fast-contracts-channels-registry-b",
        file,
      );
    }
  }

  return Object.entries(groups).map(([checkName, includePatterns]) => ({
    checkName,
    includePatterns,
    task: "contracts-channels",
    runtime: "node",
  }));
}
