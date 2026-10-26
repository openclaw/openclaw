// Hands running turns to a reloaded plugin at their next step boundary (#182024).
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { captureAgentPluginRuntimeRefresh } from "./plugin-runtime-refresh.js";

const log = createSubsystemLogger("agents/plugin-turn-handover");

// The retiring generation's manifest decides; a plugin hands turns over only when it
// declares `reload.turnHandover`, so every other plugin keeps today's wait for the turn.
function handsOverTurns(registries: Iterable<PluginRegistry>, pluginId: string): boolean {
  for (const registry of registries) {
    if (registry.plugins.some((record) => record.id === pluginId && record.turnHandover === true)) {
      return true;
    }
  }
  return false;
}

/**
 * Captures how a prepared-generation hold reacts to a reload reserving a plugin
 * it holds. Only opted-in plugins hand over:
 *
 * - Inside a turn, the hold asks the turn to stop at its next step boundary and
 *   keeps its work count, so the reload's drain waits for that boundary. The run
 *   then releases this generation and continues on the published one through
 *   the existing plugin-runtime refresh continuation.
 * - Outside a turn (admission and dispatch leases kept for a whole run), the
 *   hold yields its work count but keeps its custody. A later fresh call into
 *   the replaced plugin waits for the reload and rebinds to the current registry.
 */
export function captureTurnHandoverRequest(
  registries: Iterable<PluginRegistry>,
): (pluginId: string) => "yield" | undefined {
  const refresh = captureAgentPluginRuntimeRefresh();
  return (pluginId) => {
    if (!handsOverTurns(registries, pluginId)) {
      return undefined;
    }
    if (!refresh.isOwned()) {
      log.info(`plugin ${pluginId} reload requested; whole-run hold yields to the reload`);
      return "yield";
    }
    const requested = refresh.request();
    log.info(
      requested
        ? `plugin ${pluginId} reload requested; turn will continue on the new generation at its next step boundary`
        : `plugin ${pluginId} reload requested; turn has no step that can hand over, so the reload waits for it`,
    );
    return undefined;
  };
}
