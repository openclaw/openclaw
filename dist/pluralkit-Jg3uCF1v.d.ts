//#region extensions/discord/src/pluralkit.d.ts
type DiscordPluralKitConfig = {
  enabled?: boolean;
  token?: string;
};
type PluralKitSystemInfo = {
  id: string;
  name?: string | null;
  tag?: string | null;
};
type PluralKitMemberInfo = {
  id: string;
  name?: string | null;
  display_name?: string | null;
};
type PluralKitMessageInfo = {
  id: string;
  original?: string | null;
  sender?: string | null;
  system?: PluralKitSystemInfo | null;
  member?: PluralKitMemberInfo | null;
};
declare function fetchPluralKitMessageInfo(params: {
  messageId: string;
  config?: DiscordPluralKitConfig;
  fetcher?: typeof fetch;
}): Promise<PluralKitMessageInfo | null>;
//#endregion
export { fetchPluralKitMessageInfo as a, PluralKitSystemInfo as i, PluralKitMemberInfo as n, PluralKitMessageInfo as r, DiscordPluralKitConfig as t };