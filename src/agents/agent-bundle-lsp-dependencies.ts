/** Owns the replaceable process/config dependencies used by bundled LSP runtime tests. */
import type { ChildProcess } from "node:child_process";
import { killProcessTree } from "../process/kill-tree.js";
import { spawnLspServerProcess } from "./agent-bundle-lsp-process.js";
import { loadEmbeddedAgentLspConfig } from "./embedded-agent-lsp.js";
import type { StdioMcpServerLaunchConfig } from "./mcp-stdio.js";

export type BundleLspRuntimeDependencies = {
  loadConfig: typeof loadEmbeddedAgentLspConfig;
  spawnServerProcess: (config: StdioMcpServerLaunchConfig) => ChildProcess;
  killProcessTree: typeof killProcessTree;
};

const defaultDependencies: BundleLspRuntimeDependencies = {
  loadConfig: loadEmbeddedAgentLspConfig,
  spawnServerProcess: spawnLspServerProcess,
  killProcessTree,
};
let testDependencies: BundleLspRuntimeDependencies | undefined;

export function getBundleLspRuntimeDependencies(): BundleLspRuntimeDependencies {
  return testDependencies ?? defaultDependencies;
}

export function setBundleLspRuntimeDependenciesForTest(
  dependencies?: BundleLspRuntimeDependencies,
): void {
  testDependencies = dependencies;
}
