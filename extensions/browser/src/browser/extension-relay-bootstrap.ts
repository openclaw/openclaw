import type { ResolvedBrowserConfig } from "./config.js";
import { resolveProfile } from "./config.js";
import { getExtensionRelayModule } from "./extension-relay.runtime.js";
import type { BrowserServerState } from "./server-context.js";

export type ConfiguredExtensionRelayStarter = (
  state: BrowserServerState,
  onWarn: (message: string) => void,
) => Promise<void>;

/**
 * Prepares configured extension relays for one browser control startup path.
 *
 * Run this before publishing the shared runtime: the host-local relay key and
 * the relay module must both be available, so a failure here can still be
 * rolled back by the caller. The returned starter binds relay listeners once
 * the runtime exists. Returns null when no profile uses the extension driver.
 */
export async function prepareConfiguredExtensionRelays(
  resolved: ResolvedBrowserConfig,
): Promise<ConfiguredExtensionRelayStarter | null> {
  const hasExtensionProfiles = Object.values(resolved.profiles).some(
    (profile) => profile.driver === "extension",
  );
  if (!hasExtensionProfiles) {
    return null;
  }
  // Gateway hosts and browser node hosts each own an independent HMAC key.
  const { ensureExtensionRelayToken } = await import("./extension-relay/relay-auth.js");
  await ensureExtensionRelayToken();
  const { startConfiguredExtensionRelays } = await getExtensionRelayModule();
  return async (state, onWarn) => {
    // Relays listen from startup so the Chrome extension can (re)connect
    // before the first agent browser request arrives.
    await startConfiguredExtensionRelays(
      state,
      (name) => resolveProfile(state.resolved, name),
      onWarn,
    );
  };
}
