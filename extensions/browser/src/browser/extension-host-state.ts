import type { BrowserExtensionRequest } from "openclaw/plugin-sdk/browser-extension-host";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { BrowserError } from "./errors.js";
import type { ResolvedBrowserProfile } from "./profile.types.js";
import type { BrowserServerState, ProfileRuntimeState } from "./server-context.types.js";

/** Validated launch declaration; identity is retained on the launched process. */
export type ExtensionDeclaration = BrowserExtensionRequest & {
  version: string;
  workerPath: string;
  ownerState: BrowserServerState;
};
export const extensionDeclarations = new Map<string, ExtensionDeclaration>();

type Gate = {
  readers: number;
  exclusive: boolean;
  quarantined?: {
    runtime: ProfileRuntimeState;
    running: NonNullable<ProfileRuntimeState["running"]>;
  };
};
const gates = new Map<string, Gate>();

/** Canonicalize explicit loopback endpoints; existing-session profiles have no cdpPort. */
function endpointKey(cdpUrl: string): string {
  const url = URL.parse(cdpUrl);
  if (!url || !isLoopbackHost(url.hostname)) {
    return cdpUrl;
  }
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  return `loopback:${port}`;
}

/** Match profile aliases without treating different loopback spellings as different browsers. */
export function matchesExtensionBrowserEndpoint(
  profile: ResolvedBrowserProfile,
  cdpUrl: string,
): boolean {
  return endpointKey(profile.cdpUrl) === endpointKey(cdpUrl);
}

function gateFor(runtime: ProfileRuntimeState): { key: string; gate: Gate } {
  // The URL is authoritative even for drivers whose legacy cdpPort field is zero.
  const key = endpointKey(runtime.profile.cdpUrl);
  let gate = gates.get(key);
  if (!gate) {
    gate = { readers: 0, exclusive: false };
    gates.set(key, gate);
  }
  const quarantine = gate.quarantined;
  // Only the owning process's retirement clears quarantine, never an alias's
  // empty running field. The browser lifecycle publishes this settled fact.
  if (quarantine && quarantine.runtime.running !== quarantine.running) {
    gate.quarantined = undefined;
  }
  return { key, gate };
}

function releaseIdleGate(key: string, gate: Gate): void {
  if (!gate.exclusive && gate.readers === 0 && !gate.quarantined) {
    gates.delete(key);
  }
}

/** Fail closed after an uncertain worker call until the owned browser is stopped. */
export function quarantineExtensionProfile(runtime: ProfileRuntimeState): void {
  if (runtime.running) {
    gateFor(runtime).gate.quarantined = { runtime, running: runtime.running };
  }
}

/** Whether a continuous capture may attach to this profile right now. */
export function isExtensionProfileLocked(runtime: ProfileRuntimeState): boolean {
  const { key, gate } = gateFor(runtime);
  const locked = gate.exclusive || Boolean(gate.quarantined);
  releaseIdleGate(key, gate);
  return locked;
}

/** Admit whole profile operations, including in-flight reads, atomically before their first await. */
export async function withExtensionProfileGate<T>(
  runtime: ProfileRuntimeState,
  exclusive: boolean,
  run: () => Promise<T>,
): Promise<T> {
  const { key, gate } = gateFor(runtime);
  if (gate.exclusive || gate.quarantined || (exclusive && gate.readers > 0)) {
    throw new BrowserError(
      gate.quarantined
        ? "Browser profile quarantined after an uncertain extension call. Stop the browser before continuing."
        : "Browser profile busy: an exclusive extension operation conflicts with browser actions. Retry after it finishes.",
      409,
    );
  }
  if (exclusive) {
    gate.exclusive = true;
  } else {
    gate.readers += 1;
  }
  try {
    return await run();
  } finally {
    if (exclusive) {
      gate.exclusive = false;
    } else {
      gate.readers -= 1;
    }
    releaseIdleGate(key, gate);
  }
}

/** Release declarations only after successful runtime or terminal profile cleanup. */
export function releaseBrowserExtensionDeclarations(
  state: BrowserServerState,
  retiredProfile?: string,
): void {
  for (const [profileName, declaration] of extensionDeclarations) {
    if (
      declaration.ownerState === state &&
      (retiredProfile === undefined || retiredProfile === profileName)
    ) {
      extensionDeclarations.delete(profileName);
    }
  }
  // Quarantine is process-scoped; successful shutdown must not retain retired runtimes.
  for (const [key, gate] of gates) {
    const quarantine = gate.quarantined;
    if (quarantine && quarantine.runtime.running !== quarantine.running) {
      gate.quarantined = undefined;
    }
    releaseIdleGate(key, gate);
  }
}
