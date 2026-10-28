import { isDeepStrictEqual } from "node:util";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type { MSTeamsConfig } from "../../runtime-api.js";
import {
  listMSTeamsAccountIds,
  resolveMSTeamsAccountConfig,
  withAccountScopedMSTeamsConfig,
} from "../accounts.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";

const allowlistInputs = (config: MSTeamsConfig) => [
  config.allowFrom,
  config.groupAllowFrom,
  config.teams,
  config.dangerouslyAllowNameMatching,
];

export function createMSTeamsHandlerConfigReader(deps: MSTeamsMessageHandlerDeps) {
  const source = deps.accountPolicyCfg ?? deps.cfg;
  const read = createRuntimeConfigReader(source);
  const originallyConfigured = listMSTeamsAccountIds(source).includes(deps.accountId);
  // Startup-resolved allowlists stay in force until an input edit, which also restarts the channel.
  const startupInputs =
    deps.accountPolicyCfg && allowlistInputs(resolveMSTeamsAccountConfig(source, deps.accountId));
  const startup = deps.cfg.channels?.msteams;
  const startupAllowlists = {
    allowFrom: startup?.allowFrom,
    groupAllowFrom: startup?.groupAllowFrom,
    teams: startup?.teams,
  };
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
    const accountConfig = resolveMSTeamsAccountConfig(current, deps.accountId);
    const keepStartup =
      current.channels?.msteams !== undefined &&
      isDeepStrictEqual(allowlistInputs(accountConfig), startupInputs);
    if (deps.accountId === "default" && !current.channels?.msteams?.accounts && !retired) {
      return (lastProjection = keepStartup
        ? withAccountScopedMSTeamsConfig({
            cfg: current,
            accountId: deps.accountId,
            accountConfig: { ...current.channels?.msteams, ...startupAllowlists },
          })
        : current);
    }
    return (lastProjection = withAccountScopedMSTeamsConfig({
      cfg: current,
      accountId: deps.accountId,
      accountConfig: {
        ...accountConfig,
        ...(keepStartup ? startupAllowlists : {}),
        ...(current.channels?.msteams?.enabled === false || retired ? { enabled: false } : {}),
      },
    }));
  };
}
