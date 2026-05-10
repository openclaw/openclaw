/**
 * Default configuration values for the Home Assistant kiosk bridge.
 *
 * The HA URL points at the household HA host. The token reference points at a
 * dedicated non-admin HA user (`jarvis_kiosk`) -- a sibling of the
 * `jarvis_butler` user owned by the Jarvis Butler plan
 * (docs/plans/2026-05-10-001-feat-jarvis-the-butler-home-migration-plan.md).
 *
 * Two separate users so the kiosk and the agent rotate independently and so a
 * compromised tablet cannot use the agent's credentials.
 */

export const DEFAULT_HOME_ASSISTANT_URL = "ws://192.168.2.41:8123/api/websocket";

export const DEFAULT_TOKEN_REF = "homeAssistant.jarvisKiosk";

/**
 * Services the kiosk must never call. Mirrors the HA-user-side deny-list
 * documented in the Butler plan; the user-side deny-list is the safety net,
 * this client-side list is defense in depth so a forbidden tile never even
 * issues the call.
 */
export const DEFAULT_DENY_SERVICE_LIST: readonly string[] = [
  "lock.unlock",
  "alarm_control_panel.alarm_disarm",
  "cover.open_cover",
];
