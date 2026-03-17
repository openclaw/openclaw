function resolveTlonAccount(cfg, accountId) {
  const base = cfg.channels?.tlon;
  if (!base) {
    return {
      accountId: accountId || "default",
      name: null,
      enabled: false,
      configured: false,
      ship: null,
      url: null,
      code: null,
      allowPrivateNetwork: null,
      groupChannels: [],
      dmAllowlist: [],
      groupInviteAllowlist: [],
      autoDiscoverChannels: null,
      showModelSignature: null,
      autoAcceptDmInvites: null,
      autoAcceptGroupInvites: null,
      defaultAuthorizedShips: [],
      ownerShip: null
    };
  }
  const useDefault = !accountId || accountId === "default";
  const account = useDefault ? base : base.accounts?.[accountId];
  const ship = account?.ship ?? base.ship ?? null;
  const url = account?.url ?? base.url ?? null;
  const code = account?.code ?? base.code ?? null;
  const allowPrivateNetwork = account?.allowPrivateNetwork ?? base.allowPrivateNetwork ?? null;
  const groupChannels = account?.groupChannels ?? base.groupChannels ?? [];
  const dmAllowlist = account?.dmAllowlist ?? base.dmAllowlist ?? [];
  const groupInviteAllowlist = account?.groupInviteAllowlist ?? base.groupInviteAllowlist ?? [];
  const autoDiscoverChannels = account?.autoDiscoverChannels ?? base.autoDiscoverChannels ?? null;
  const showModelSignature = account?.showModelSignature ?? base.showModelSignature ?? null;
  const autoAcceptDmInvites = account?.autoAcceptDmInvites ?? base.autoAcceptDmInvites ?? null;
  const autoAcceptGroupInvites = account?.autoAcceptGroupInvites ?? base.autoAcceptGroupInvites ?? null;
  const ownerShip = account?.ownerShip ?? base.ownerShip ?? null;
  const defaultAuthorizedShips = account?.defaultAuthorizedShips ?? base?.defaultAuthorizedShips ?? [];
  const configured = Boolean(ship && url && code);
  return {
    accountId: accountId || "default",
    name: account?.name ?? base.name ?? null,
    enabled: (account?.enabled ?? base.enabled ?? true) !== false,
    configured,
    ship,
    url,
    code,
    allowPrivateNetwork,
    groupChannels,
    dmAllowlist,
    groupInviteAllowlist,
    autoDiscoverChannels,
    showModelSignature,
    autoAcceptDmInvites,
    autoAcceptGroupInvites,
    defaultAuthorizedShips,
    ownerShip
  };
}
function listTlonAccountIds(cfg) {
  const base = cfg.channels?.tlon;
  if (!base) {
    return [];
  }
  const accounts = base.accounts ?? {};
  return [...base.ship ? ["default"] : [], ...Object.keys(accounts)];
}
export {
  listTlonAccountIds,
  resolveTlonAccount
};
