import fs from "node:fs/promises";
import { runWithLocalStateOwner } from "openclaw/plugin-sdk/cli-state-owner";
import { readConfigFileSnapshot } from "openclaw/plugin-sdk/health";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  defaultRuntime,
  readRootMemoryForTrust,
  restoreRootMemoryTrust,
} from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import {
  resolveConfiguredAgentId,
  resolveDefaultAgentId,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { terminalText } from "openclaw/plugin-sdk/terminal-safe-text";

export async function runMemoryTrust(opts: { agent?: string; sha256?: string }): Promise<void> {
  if (opts.sha256 !== undefined && !/^[a-fA-F0-9]{64}$/u.test(opts.sha256)) {
    throw new Error("--sha256 must be a 64-digit hexadecimal SHA-256 digest.");
  }
  const reviewedSha256 = opts.sha256?.toLowerCase();
  await runWithLocalStateOwner({
    method: "memory.trust",
    params: {},
    target: "root MEMORY.md provenance",
    onForeignOwner: "refuse",
    ...(reviewedSha256 ? { databaseEngine: "configured" } : { databaseAccess: "none" }),
    runLocal: async ({ env, localGatewayAbsent, assertCurrent }) => {
      if (!localGatewayAbsent) {
        throw new Error(
          "Memory trust requires exclusive offline state ownership. Stop the Gateway and retry.",
        );
      }
      // Preview does not load writable runtime config or open the provenance store.
      const snapshot = await readConfigFileSnapshot({ observe: false, isolateEnv: true });
      if (!snapshot.valid) {
        throw new Error(
          "Cannot resolve an agent workspace from invalid config. Run openclaw doctor.",
        );
      }
      const cfg = snapshot.config;
      if (cfg.gateway?.mode === "remote") {
        throw new Error("Memory trust must run on the local Gateway host with its configuration.");
      }
      const agentId =
        opts.agent === undefined
          ? resolveDefaultAgentId(cfg)
          : resolveConfiguredAgentId(cfg, opts.agent.trim());
      const configuredDir = resolveAgentWorkspaceDir(cfg, agentId, env);
      // A Gateway-local directory can be a placeholder for a node-backed workspace.
      const remoteWorkspaces = asOptionalRecord(
        resolvePluginConfigObject(cfg, "file-transfer")?.workspaces,
      );
      const workspaceDir = await fs.realpath(configuredDir);
      for (const remoteAgent of Object.keys(remoteWorkspaces ?? {})) {
        const remoteDir = resolveAgentWorkspaceDir(cfg, remoteAgent, env);
        if (
          remoteAgent === agentId ||
          remoteDir === configuredDir ||
          (await fs.realpath(remoteDir).catch(() => undefined)) === workspaceDir
        ) {
          throw new Error("Memory trust is not supported for node-backed workspaces.");
        }
      }
      assertCurrent();
      if (!reviewedSha256) {
        const file = await readRootMemoryForTrust(workspaceDir);
        assertCurrent();
        defaultRuntime.log("Preview only; no trust was changed.");
        defaultRuntime.log(terminalText`Review this entire file: ${file.filePath}`);
        defaultRuntime.log("SHA-256: " + file.sha256);
        defaultRuntime.log(
          terminalText`After reviewing, rerun with --agent ${agentId} --sha256 ${file.sha256}`,
        );
        return;
      }
      const result = await restoreRootMemoryTrust({ workspaceDir, reviewedSha256 });
      const outcome = result.changed
        ? "Restored trust for"
        : "Tracked provenance is already trusted for";
      defaultRuntime.log(terminalText`${outcome} ${result.filePath} (SHA-256: ${reviewedSha256}).`);
    },
  });
}
