// DingTalk does not yet ship a structured secret contract registry like
// Feishu's `channelSecrets`. Plugin secrets (clientId / clientSecret) are
// described inline in `openclaw.plugin.json` and resolved by the channel's
// own SecretInput helpers. This barrel keeps the bundled-entry shape
// uniform with the other extensions in case we add a registry later.

export const channelSecrets = undefined;
export const collectRuntimeConfigAssignments = undefined;
export const secretTargetRegistryEntries: ReadonlyArray<unknown> = [];
