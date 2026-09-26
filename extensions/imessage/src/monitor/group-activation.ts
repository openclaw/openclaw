import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeGroupActivation } from "openclaw/plugin-sdk/group-activation";
import { getIMessageRuntime } from "../runtime.js";

export function createIMessageGroupActivationResolver(logVerbose: (message: string) => void) {
  return async (params: { agentId: string; sessionKey: string; cfg: OpenClawConfig }) => {
    const session = getIMessageRuntime().agent.session;
    const storePath = session.resolveStorePath(params.cfg.session?.store, {
      agentId: params.agentId,
    });
    try {
      const activation = normalizeGroupActivation(
        (
          await session.getSessionEntryInWorker({
            agentId: params.agentId,
            storePath,
            sessionKey: params.sessionKey,
          })
        )?.groupActivation,
      );
      if (activation === "always") {
        return false;
      }
      if (activation === "mention") {
        return true;
      }
    } catch (err) {
      logVerbose(`Failed to load session for activation check: ${String(err)}`);
    }
    return undefined;
  };
}
