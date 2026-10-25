// PROTOTYPE (#182024): hands running turns to a reloaded plugin at their next step boundary.
import { createSubsystemLogger } from "../logging/subsystem.js";
import { captureAgentPluginRuntimeRefresh } from "./plugin-runtime-refresh.js";

const log = createSubsystemLogger("agents/plugin-turn-handover");

/**
 * Plugins whose reload may hand a running turn to the new generation. Stands in
 * for the manifest opt-in (`reload.turnHandover`) the issue proposes; the
 * prototype reads it from `OPENCLAW_PLUGIN_TURN_HANDOVER` (comma-separated IDs).
 */
function turnHandoverPluginIds(): ReadonlySet<string> {
  return new Set(
    (process.env.OPENCLAW_PLUGIN_TURN_HANDOVER ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
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
export function captureTurnHandoverRequest(): (pluginId: string) => "yield" | undefined {
  const refresh = captureAgentPluginRuntimeRefresh();
  return (pluginId) => {
    if (!turnHandoverPluginIds().has(pluginId)) {
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
