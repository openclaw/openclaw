import { resolveCodexAppServerPreparedAuthHandoff } from "./auth-bridge.js";
import type { CodexRunAttemptInput } from "./run-attempt-types.js";

/** Resolves whether host credentials or the destination's own login prepares Codex startup. */
export async function resolveCodexStartupAuthHandoff(
  params: Parameters<typeof resolveCodexAppServerPreparedAuthHandoff>[0] & {
    nativeConnectionAuth: boolean;
    scheduledConfiguredKey?: CodexRunAttemptInput["params"]["scheduledConfiguredKey"];
  },
) {
  const { nativeConnectionAuth, scheduledConfiguredKey } = params;
  if (scheduledConfiguredKey && (nativeConnectionAuth || params.homeScope === "user")) {
    throw scheduledConfiguredKey.unavailable;
  }
  if (nativeConnectionAuth) {
    return { authProfileId: undefined, nativeAuthProfile: true, preparedAuth: undefined };
  }
  const handoff = await resolveCodexAppServerPreparedAuthHandoff(params);
  if (scheduledConfiguredKey) {
    if (handoff.preparedAuth?.kind !== "api-key") {
      throw scheduledConfiguredKey.unavailable;
    }
    scheduledConfiguredKey.onSelected();
  }
  return handoff;
}
