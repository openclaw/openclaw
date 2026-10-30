import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  listMSTeamsAccountIds,
  resolveMSTeamsAccountConfig,
  withAccountScopedMSTeamsConfig,
} from "../accounts.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";

export function createMSTeamsHandlerConfigReader(deps: MSTeamsMessageHandlerDeps) {
  const source = deps.accountPolicyCfg ?? deps.cfg;
  const read = createRuntimeConfigReader(source);
  const originallyConfigured = listMSTeamsAccountIds(source).includes(deps.accountId);
  let lastSource: MSTeamsMessageHandlerDeps["cfg"] | undefined;
  let lastProjection = deps.cfg;
  return () => {
    const current = read();
    if (current === lastSource) {
      return lastProjection;
    }
    lastSource = current;
    if (current === source && deps.accountPolicyCfg) {
      return (lastProjection = deps.cfg);
    }
    const retired =
      originallyConfigured && !listMSTeamsAccountIds(current).includes(deps.accountId);
    if (deps.accountId === "default" && !current.channels?.msteams?.accounts && !retired) {
      return (lastProjection = current);
    }
    const accountConfig = resolveMSTeamsAccountConfig(current, deps.accountId);
    return (lastProjection = withAccountScopedMSTeamsConfig({
      cfg: current,
      accountId: deps.accountId,
      accountConfig: {
        ...accountConfig,
        ...(current.channels?.msteams?.enabled === false || retired ? { enabled: false } : {}),
      },
    }));
  };
}
