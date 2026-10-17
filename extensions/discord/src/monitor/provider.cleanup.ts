import { danger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { MutableDiscordGateway } from "./gateway-handle.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

export async function cleanupDiscordProviderStartup(params: {
  deactivateMessageHandler?: () => void | Promise<void>;
  stopMonitorListeners?: () => Promise<void>;
  autoPresenceController?: { stop: () => void | Promise<void> } | null;
  setStatus?: DiscordMonitorStatusSink;
  lifecycleStarted: boolean;
  lifecycleGateway?: MutableDiscordGateway;
  gatewaySupervisor?: { dispose: () => void };
  threadBindings: ThreadBindingManager;
  runtime: RuntimeEnv;
}) {
  try {
    const listenersStopped = params.stopMonitorListeners?.();
    try {
      await params.deactivateMessageHandler?.();
    } finally {
      await listenersStopped;
    }
    await params.autoPresenceController?.stop();
    params.setStatus?.({ connected: false });
    if (!params.lifecycleStarted) {
      try {
        params.lifecycleGateway?.disconnect();
      } catch (err) {
        params.runtime.error?.(
          danger(`discord: failed to disconnect gateway during startup cleanup: ${String(err)}`),
        );
      }
    }
    params.gatewaySupervisor?.dispose();
  } finally {
    if (!params.lifecycleStarted) {
      await params.threadBindings.stop();
    }
  }
}
