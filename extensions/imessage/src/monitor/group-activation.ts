import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeGroupActivation } from "openclaw/plugin-sdk/group-activation";
import { getIMessageRuntime } from "../runtime.js";

export type IMessageGroupActivationOverride = boolean | "read_failed" | undefined;

export function createIMessageGroupActivationResolver(logVerbose: (message: string) => void) {
  return async (params: {
    agentId: string;
    sessionKey: string;
    cfg: OpenClawConfig;
  }): Promise<IMessageGroupActivationOverride> => {
    const session = getIMessageRuntime().agent.session;
    try {
      const activation = normalizeGroupActivation(
        (
          await session.getSessionEntryAsync?.({
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            storePath: session.resolveStorePath(params.cfg.session?.store, {
              agentId: params.agentId,
            }),
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
      return "read_failed";
    }
    return undefined;
  };
}
