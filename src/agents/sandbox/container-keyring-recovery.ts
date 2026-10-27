/** Reclaim one inactive runtime only after container creation exhausts the host key quota. */
import { listExecSessionsForCancellation } from "../bash-process-registry.js";
import { execContainer, type SandboxContainerEngine } from "./container-engine.js";
import { containerState } from "./container-inspect.js";
import {
  isSandboxContainerLifecycleBusy,
  withSandboxContainerLifecycle,
} from "./container-lifecycle.js";
import { isSandboxContainerInUse } from "./container-usage.js";
import { validateSandboxContainerEngineTarget } from "./podman-runtime.js";
import { assertSandboxRegistryEntryCurrent, readRegistry } from "./registry.js";
import { resolveSandboxAgentId } from "./shared.js";
import { captureSandboxStateOwner } from "./state-owner.js";

function hasActiveUsage(scopeKey: string): boolean {
  const agentId = resolveSandboxAgentId(scopeKey);
  // Process scopes can differ from workspace/profile scopes. Overprotect the agent
  // rather than guessing which container owns a still-running or uncertain exec.
  return (
    isSandboxContainerInUse(scopeKey) ||
    listExecSessionsForCancellation().some(
      (process) =>
        (!process.exited ||
          process.finalizing ||
          process.cleanupUncertain ||
          process.finalizationFailed) &&
        (!agentId || !process.agentId || process.agentId === agentId),
    )
  );
}

export async function reclaimIdleSandboxContainer(options: {
  engine: SandboxContainerEngine;
  assertCurrent?: () => void;
}): Promise<void> {
  const assertOwner = await captureSandboxStateOwner();
  const assertCurrent = () => {
    assertOwner();
    options.assertCurrent?.();
  };
  const { entries } = await readRegistry();
  assertCurrent();
  for (const entry of entries.toSorted((a, b) => a.lastUsedAtMs - b.lastUsedAtMs)) {
    if (
      (entry.backendId ?? "docker") !== options.engine.id ||
      !entry.backendTarget ||
      JSON.stringify(entry.backendTarget.globalArgs) !==
        JSON.stringify(options.engine.globalArgs ?? []) ||
      (entry.runtimeState && entry.runtimeState !== "ready") ||
      isSandboxContainerLifecycleBusy(entry.containerName) ||
      hasActiveUsage(entry.sessionKey)
    ) {
      continue;
    }
    const stopped = await withSandboxContainerLifecycle(
      entry.containerName,
      undefined,
      async () => {
        const engine = options.engine;
        await validateSandboxContainerEngineTarget(engine, entry.backendTarget);
        const state = await containerState(engine, entry.containerName, { strict: true });
        if (!state.exists || !state.running) {
          return false;
        }
        if (engine.id === "docker") {
          const { hasSandboxPersistentExecCustody } = await import("./persistent-exec.js");
          if (
            await hasSandboxPersistentExecCustody({
              containerName: entry.containerName,
              containerId: state.id,
            })
          ) {
            return false;
          }
        }
        assertCurrent();
        assertSandboxRegistryEntryCurrent(entry);
        if (hasActiveUsage(entry.sessionKey)) {
          return false;
        }
        await execContainer(engine, ["stop", "--time", "10", state.id], {
          signal: AbortSignal.timeout(30_000),
          assertCurrent,
        });
        return true;
      },
    );
    if (stopped) {
      return;
    }
  }
}
