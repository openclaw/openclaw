const msteamsSessionTurnChains = new Map<string, Promise<void>>();

function resolveMSTeamsTurnChainKey(params: { storePath?: string; sessionKey: string }): string {
  const sessionKey = params.sessionKey.trim();
  const storePath = params.storePath?.trim();
  if (storePath) {
    return sessionKey ? `store:${storePath}:session:${sessionKey}` : `store:${storePath}`;
  }
  return sessionKey ? `session:${sessionKey}` : "";
}

export async function enqueueMSTeamsSessionTurn<T>(
  params: { storePath?: string; sessionKey: string },
  task: () => Promise<T>,
): Promise<T> {
  const key = resolveMSTeamsTurnChainKey(params);
  if (!key) {
    return await task();
  }
  const previous = msteamsSessionTurnChains.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  msteamsSessionTurnChains.set(key, settled);
  const cleanup = () => {
    if (msteamsSessionTurnChains.get(key) === settled) {
      msteamsSessionTurnChains.delete(key);
    }
  };
  settled.then(cleanup, cleanup);
  return await current;
}

export function formatMSTeamsSenderReason(params: {
  reasonCode: string;
  dmPolicy?: string;
  groupPolicy?: string;
}): string {
  switch (params.reasonCode) {
    case "dm_policy_open":
      return "dmPolicy=open";
    case "dm_policy_disabled":
      return "dmPolicy=disabled";
    case "dm_policy_pairing_required":
      return "dmPolicy=pairing (not allowlisted)";
    case "dm_policy_allowlisted":
      return `dmPolicy=${params.dmPolicy ?? "allowlist"} (allowlisted)`;
    case "dm_policy_not_allowlisted":
      return `dmPolicy=${params.dmPolicy ?? "allowlist"} (not allowlisted)`;
    case "group_policy_disabled":
      return "groupPolicy=disabled";
    case "group_policy_empty_allowlist":
    case "route_sender_empty":
      return "groupPolicy=allowlist (empty allowlist)";
    case "group_policy_not_allowlisted":
      return "groupPolicy=allowlist (not allowlisted)";
    case "group_policy_open":
      return "groupPolicy=open";
    case "group_policy_allowed":
      return `groupPolicy=${params.groupPolicy ?? "allowlist"}`;
    default:
      return params.reasonCode;
  }
}
