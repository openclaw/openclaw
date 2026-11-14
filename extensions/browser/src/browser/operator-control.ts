/**
 * Operator take-over of one browser, matching desktop computer control.
 *
 * Nothing changes until someone clicks Take control in the Browser panel. While that Control UI
 * connection holds control, input from anyone else (agent tools, CLI, other clients) is refused
 * at the shared route boundary; observation stays available and input that already started may
 * finish. Control ends when the holder releases it, disconnects, or sends no input for
 * BROWSER_OPERATOR_CONTROL_IDLE_MS, and when the browser runtime stops.
 */
import type { ResolvedBrowserProfile } from "./profile.types.js";
import type { BrowserRequest } from "./routes/types.js";
import type { BrowserServerState } from "./server-context.types.js";

export const BROWSER_OPERATOR_CONTROL_MESSAGE =
  "Browser input paused while the operator has control; wait until they release control in the Browser panel";
const BROWSER_OPERATOR_CONTROL_IDLE_MS = 5 * 60_000;

type ProfileControl = {
  controller?: { connId: string; lastInputAt: number; release: () => void };
};

const controls = new WeakMap<BrowserServerState, Map<string, ProfileControl>>();

/**
 * Control belongs to the browser, not the profile name: several profiles may reach one browser
 * through the same cdpUrl. Existing-session profiles without a cdpUrl attach to the local Chrome
 * profile in their user data dir. Spelling one address two ways (localhost vs 127.0.0.1) still
 * gives two keys; accepted, as it needs a deliberately split config.
 */
function browserKey(profile: ResolvedBrowserProfile): string {
  return profile.cdpUrl || `${profile.driver}:${profile.userDataDir ?? "default"}`;
}

function profileControl(
  state: BrowserServerState,
  profile: ResolvedBrowserProfile,
): ProfileControl {
  let byProfile = controls.get(state);
  if (!byProfile) {
    byProfile = new Map();
    controls.set(state, byProfile);
  }
  let control = byProfile.get(browserKey(profile));
  if (!control) {
    control = {};
    byProfile.set(browserKey(profile), control);
  }
  return control;
}

// GET routes and these POST routes only read the page; everything else is input.
const OBSERVATION_POST_ROUTES = new Set([
  "/screenshot",
  "/pdf",
  "/screencast",
  "/response/body",
  "/trace/start",
  "/trace/stop",
]);

export function isBrowserInputRoute(method: "GET" | "POST" | "DELETE", path: string): boolean {
  return method !== "GET" && !OBSERVATION_POST_ROUTES.has(path);
}

/** False while a connection other than `connId` holds control of this browser. */
export function admitBrowserInput(
  state: BrowserServerState,
  profile: ResolvedBrowserProfile,
  connId: string | undefined,
): boolean {
  const controller = controls.get(state)?.get(browserKey(profile))?.controller;
  return !controller || controller.connId === connId;
}

/**
 * Record deliberate input from a Gateway client; the Browser panel marks it on each request.
 * It keeps the holder's control from going idle.
 */
export function recordBrowserOperatorInput(
  state: BrowserServerState,
  profile: ResolvedBrowserProfile,
  connId: string | undefined,
): void {
  const controller = controls.get(state)?.get(browserKey(profile))?.controller;
  if (connId && controller?.connId === connId) {
    controller.lastInputAt = Date.now();
  }
}

/**
 * `available` is false when the request carries no Control UI connection, for example when the
 * Gateway forwards it to a browser node; the panel offers Take control only where it is true.
 */
type BrowserOperatorControlStatus = { available: boolean; controlled: boolean; byYou: boolean };

export function readBrowserOperatorControl(
  state: BrowserServerState,
  profile: ResolvedBrowserProfile,
  connId: string | undefined,
): BrowserOperatorControlStatus {
  const controller = controls.get(state)?.get(browserKey(profile))?.controller;
  return {
    available: connId !== undefined,
    controlled: controller !== undefined,
    byYou: controller !== undefined && controller.connId === connId,
  };
}

/** Give control to the requesting connection; a later taker replaces the current one. */
export function takeBrowserOperatorControl(
  state: BrowserServerState,
  profile: ResolvedBrowserProfile,
  requester: NonNullable<BrowserRequest["requester"]> & { connId: string },
): BrowserOperatorControlStatus {
  const control = profileControl(state, profile);
  if (control.controller?.connId === requester.connId) {
    control.controller.lastInputAt = Date.now();
    return readBrowserOperatorControl(state, profile, requester.connId);
  }
  control.controller?.release();
  const connId = requester.connId;
  const release = () => releaseBrowserOperatorControl(state, profile, connId);
  // A forgotten takeover must not block the agent for good: release after idle input.
  const checkIdle = () => {
    const controller = control.controller;
    if (controller?.connId !== connId) {
      return;
    }
    const idleFor = Date.now() - controller.lastInputAt;
    if (idleFor >= BROWSER_OPERATOR_CONTROL_IDLE_MS) {
      release();
    } else {
      timer = setTimeout(checkIdle, BROWSER_OPERATOR_CONTROL_IDLE_MS - idleFor);
      timer.unref?.();
    }
  };
  let timer = setTimeout(checkIdle, BROWSER_OPERATOR_CONTROL_IDLE_MS);
  timer.unref?.();
  requester.signal.addEventListener("abort", release, { once: true });
  control.controller = {
    connId,
    lastInputAt: Date.now(),
    release: () => {
      clearTimeout(timer);
      requester.signal.removeEventListener("abort", release);
      if (control.controller?.connId === connId) {
        control.controller = undefined;
      }
    },
  };
  if (requester.signal.aborted) {
    release();
  }
  return readBrowserOperatorControl(state, profile, connId);
}

/** Release control held by this connection; another connection's control is left alone. */
export function releaseBrowserOperatorControl(
  state: BrowserServerState,
  profile: ResolvedBrowserProfile,
  connId: string | undefined,
): BrowserOperatorControlStatus {
  const controller = controls.get(state)?.get(browserKey(profile))?.controller;
  if (controller && controller.connId === connId) {
    controller.release();
  }
  return readBrowserOperatorControl(state, profile, connId);
}
