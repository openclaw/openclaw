import { TSchema } from "typebox";

//#region src/channels/plugins/actions/shared.d.ts
type OptionalDefaultGate<TKey extends string> = (key: TKey, defaultValue?: boolean) => boolean;
type TokenSourcedAccount = {
  tokenSource?: string | null;
};
declare function listTokenSourcedAccounts<TAccount extends TokenSourcedAccount>(accounts: readonly TAccount[]): TAccount[];
declare function createUnionActionGate<TAccount, TKey extends string>(accounts: readonly TAccount[], createGate: (account: TAccount) => OptionalDefaultGate<TKey>): OptionalDefaultGate<TKey>;
//#endregion
//#region src/channels/plugins/actions/reaction-message-id.d.ts
type ReactionToolContext = {
  currentMessageId?: string | number;
};
declare function resolveReactionMessageId(params: {
  args: Record<string, unknown>;
  toolContext?: ReactionToolContext;
}): string | number | undefined;
//#endregion
//#region src/plugin-sdk/channel-actions.d.ts
/**
 * @deprecated Use semantic `presentation` capabilities instead of exposing
 * provider-native button schemas through the shared message tool.
 */
declare function createMessageToolButtonsSchema(): TSchema;
/**
 * @deprecated Use semantic `presentation` capabilities instead of exposing
 * provider-native card schemas through the shared message tool.
 */
declare function createMessageToolCardSchema(): TSchema;
//#endregion
export { listTokenSourcedAccounts as a, createUnionActionGate as i, createMessageToolCardSchema as n, resolveReactionMessageId as r, createMessageToolButtonsSchema as t };