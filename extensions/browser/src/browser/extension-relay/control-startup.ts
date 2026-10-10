import { resolveProfile } from "../config.js";
import { getExtensionRelayModule } from "../extension-relay.runtime.js";
import type { BrowserServerState } from "../server-context.js";

/** Start relays for extension-driver profiles only. Managed profiles do not bind a port. */
export async function startControlStateExtensionRelays(
  state: BrowserServerState,
  onWarn: (message: string) => void,
): Promise<void> {
  const hasExtensionProfiles = Object.values(state.resolved.profiles).some(
    (profile) => profile.driver === "extension",
  );
  if (!hasExtensionProfiles) {
    return;
  }
  const { startConfiguredExtensionRelays } = await getExtensionRelayModule();
  await startConfiguredExtensionRelays(
    state,
    (name) => resolveProfile(state.resolved, name),
    onWarn,
  );
}
