import { r as SecretDefaults, t as ResolverContext } from "./runtime-shared-Ckgewnqv.js";
import { n as ChannelAccountPredicate, r as ChannelAccountSurface } from "./channel-secret-basic-runtime-C3XzMmeE.js";

//#region src/secrets/channel-secret-tts-runtime.d.ts
declare function collectNestedChannelTtsAssignments(params: {
  channelKey: string;
  nestedKey: string;
  channel: Record<string, unknown>;
  surface: ChannelAccountSurface;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  topLevelActive: boolean;
  topInactiveReason: string;
  accountActive: ChannelAccountPredicate;
  accountInactiveReason: string | ((entry: {
    accountId: string;
    account: Record<string, unknown>;
    enabled: boolean;
  }) => string);
}): void;
//#endregion
export { collectNestedChannelTtsAssignments as t };