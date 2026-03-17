function buildTlonAccountFields(input) {
  return {
    ...input.ship ? { ship: input.ship } : {},
    ...input.url ? { url: input.url } : {},
    ...input.code ? { code: input.code } : {},
    ...typeof input.allowPrivateNetwork === "boolean" ? { allowPrivateNetwork: input.allowPrivateNetwork } : {},
    ...input.groupChannels ? { groupChannels: input.groupChannels } : {},
    ...input.dmAllowlist ? { dmAllowlist: input.dmAllowlist } : {},
    ...typeof input.autoDiscoverChannels === "boolean" ? { autoDiscoverChannels: input.autoDiscoverChannels } : {},
    ...input.ownerShip ? { ownerShip: input.ownerShip } : {}
  };
}
export {
  buildTlonAccountFields
};
