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
  const suffixes = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const groups = Object.fromEntries(
    ["registry", "core"].flatMap((family) =>
      suffixes.map((suffix) => [`checks-fast-contracts-channels-${family}-${suffix}`, []]),
    ),
  );
  const groupKeys = {
    core: suffixes.map((suffix) => `checks-fast-contracts-channels-core-${suffix}`),
    registry: suffixes.map((suffix) => `checks-fast-contracts-channels-registry-${suffix}`),
  };
  const pushBalanced = (keys, file) => {
    const target = keys.toSorted((a, b) => groups[a].length - groups[b].length)[0];
    groups[target].push(file);
  };

  for (const file of listContractTestFiles(rootDir)) {
    const name = relative(rootDir, file).replaceAll("\\", "/");
    if (name.startsWith("plugins-core.") || name.startsWith("plugin.")) {
      pushBalanced(groupKeys.core, file);
    } else {
      pushBalanced(groupKeys.registry, file);
    }
  }

  return Object.entries(groups).map(([checkName, includePatterns]) => ({
    checkName,
    includePatterns,
    task: "contracts-channels",
    runtime: "node",
  }));
}
