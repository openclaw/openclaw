//#region src/plugin-sdk/account-configured-ids.d.ts
/** List normalized configured account ids from a raw channel account record map. */
declare function listConfiguredAccountIds(params: {
  accounts: Record<string, unknown> | undefined;
  normalizeAccountId: (accountId: string) => string;
}): string[];
//#endregion
export { listConfiguredAccountIds as t };