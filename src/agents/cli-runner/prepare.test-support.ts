import { vi } from "vitest";
import * as grants from "../../gateway/mcp-grant-store.js";
import * as mcpServer from "../../gateway/mcp-http.js";
import * as loopback from "../../gateway/mcp-http.loopback-runtime.js";
import * as mcpTools from "../../gateway/mcp-http.runtime.js";
import * as oauth from "../auth-profiles/oauth.js";
import * as bootstrap from "../bootstrap-files.js";
import * as transcript from "../command/attempt-execution.helpers.js";
import * as referencePaths from "../docs-path.js";
import * as catalog from "../model-catalog.js";
import * as workspace from "../workspace.js";
import * as skills from "./claude-skills-plugin.js";
import * as liveSessions from "./cli-live-session-registry.js";

const installSpies = {
  isWorkspaceBootstrapPending: () => vi.spyOn(workspace, "isWorkspaceBootstrapPending"),
  makeBootstrapWarn: () => vi.spyOn(bootstrap, "makeBootstrapWarn"),
  resolveBootstrapContextForRun: () => vi.spyOn(bootstrap, "resolveBootstrapContextForRun"),
  getActiveMcpLoopbackRuntime: () => vi.spyOn(loopback, "getActiveMcpLoopbackRuntime"),
  ensureMcpLoopbackServer: () => vi.spyOn(mcpServer, "ensureMcpLoopbackServer"),
  createMcpLoopbackServerConfig: () => vi.spyOn(loopback, "createMcpLoopbackServerConfig"),
  activateMcpLoopbackClientGrantCapture: () =>
    vi.spyOn(grants, "activateMcpLoopbackClientGrantCapture"),
  bindMcpLoopbackClientGrantAdmission: () =>
    vi.spyOn(grants, "bindMcpLoopbackClientGrantAdmission"),
  deactivateMcpLoopbackClientGrantCapture: () =>
    vi.spyOn(grants, "deactivateMcpLoopbackClientGrantCapture"),
  mintMcpLoopbackClientGrant: () => vi.spyOn(grants, "mintMcpLoopbackClientGrant"),
  revokeMcpLoopbackClientGrant: () => vi.spyOn(grants, "revokeMcpLoopbackClientGrant"),
  transferMcpLoopbackClientGrant: () => vi.spyOn(grants, "transferMcpLoopbackClientGrant"),
  resolveMcpLoopbackPolicyTools: () => vi.spyOn(mcpTools, "resolveMcpLoopbackPolicyTools"),
  resolveMcpLoopbackScopedTools: () => vi.spyOn(mcpTools, "resolveMcpLoopbackScopedTools"),
  resolveOpenClawReferencePaths: () => vi.spyOn(referencePaths, "resolveOpenClawReferencePaths"),
  prepareClaudeCliSkillsPlugin: () => vi.spyOn(skills, "prepareClaudeCliSkillsPlugin"),
  claudeCliSessionTranscriptHasContent: () =>
    vi.spyOn(transcript, "claudeCliSessionTranscriptHasContent"),
  claudeCliSessionTranscriptHasOrphanedToolUse: () =>
    vi.spyOn(transcript, "claudeCliSessionTranscriptHasOrphanedToolUse"),
  getCliLiveSessionGeneration: () => vi.spyOn(liveSessions, "getCliLiveSessionGeneration"),
  resolveApiKeyForProfile: () => vi.spyOn(oauth, "resolveApiKeyForProfile"),
  loadManifestModelCatalog: () => vi.spyOn(catalog, "loadManifestModelCatalog"),
};

const restoreSpies = new Map<string, () => void>();

export function setCliRunnerPrepareTestDeps(overrides: Record<string, unknown>): void {
  for (const [name, install] of Object.entries(installSpies)) {
    const replacement = overrides[name];
    if (typeof replacement !== "function") {
      continue;
    }
    const spy = install();
    // Passing the live owner export restores a previous override without wrapping the spy in itself.
    if (replacement === spy) {
      restoreSpies.get(name)?.();
      restoreSpies.delete(name);
      continue;
    }
    spy.mockImplementation((...args: unknown[]) => replacement(...args));
    restoreSpies.set(name, () => spy.mockRestore());
  }
}

export function resetCliRunnerPrepareTestDeps(): void {
  for (const restore of restoreSpies.values()) {
    restore();
  }
  restoreSpies.clear();
}
