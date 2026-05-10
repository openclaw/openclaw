import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Registers Home Assistant runtime surfaces with the host.
 *
 * Unit 1 scaffold: no surfaces are registered yet. Subsequent units add the
 * WS client, state store, allow-list gate, and gateway bridge. Keeping this
 * function as the single registration entry point preserves the manifest-first
 * boundary -- discovery and config validation run without booting any of the
 * runtime modules listed above.
 */
export function registerHomeAssistantPlugin(_api: OpenClawPluginApi): void {
  // intentionally empty: scaffold-only registration.
}
