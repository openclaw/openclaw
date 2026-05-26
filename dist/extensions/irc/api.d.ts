import { s as ChannelSetupWizard } from "../../setup-wizard-types-DuBaq1ys.js";
import { H as ChannelSetupAdapter } from "../../types.adapters-BulQCrMx.js";
import { a as resolveDefaultIrcAccountId, i as listIrcAccountIds, n as ResolvedIrcAccount, o as resolveIrcAccount, r as listEnabledIrcAccounts, t as ircPlugin } from "../../channel-PHn5xShS.js";
import { t as setIrcRuntime } from "../../runtime-Dm7FDVlw.js";
//#region extensions/irc/src/setup-core.d.ts
declare const ircSetupAdapter: ChannelSetupAdapter;
//#endregion
//#region extensions/irc/src/setup-surface.d.ts
declare const ircSetupWizard: ChannelSetupWizard;
//#endregion
export { type ResolvedIrcAccount, ircPlugin, ircSetupAdapter, ircSetupWizard, listEnabledIrcAccounts, listIrcAccountIds, resolveDefaultIrcAccountId, resolveIrcAccount, setIrcRuntime };