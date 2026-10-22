export type TlonAccountFieldsInput = {
  ship?: string;
  url?: string;
  code?: string;
  dangerouslyAllowPrivateNetwork?: boolean;
  groupChannels?: string[];
  dmAllowlist?: string[];
  autoDiscoverChannels?: boolean;
  ownerShip?: string;
};

export function buildTlonAccountFields(input: TlonAccountFieldsInput) {
  return {
    ...(input.ship ? { ship: input.ship } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(input.dangerouslyAllowPrivateNetwork !== undefined
      ? {
          network: {
            dangerouslyAllowPrivateNetwork: input.dangerouslyAllowPrivateNetwork,
          },
        }
      : {}),
    ...(input.groupChannels ? { groupChannels: input.groupChannels } : {}),
    ...(input.dmAllowlist ? { dmAllowlist: input.dmAllowlist } : {}),
    ...(input.autoDiscoverChannels !== undefined
      ? { autoDiscoverChannels: input.autoDiscoverChannels }
      : {}),
    ...(input.ownerShip ? { ownerShip: input.ownerShip } : {}),
  };
}
