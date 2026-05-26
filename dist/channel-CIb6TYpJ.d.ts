import { t as BaseProbeResult } from "./types.core-BkmTlRzr.js";
import { n as ChannelPlugin } from "./types.public-B2Ho5PN_.js";
//#region extensions/msteams/src/probe.d.ts
type ProbeMSTeamsResult = BaseProbeResult<string> & {
  appId?: string;
  graph?: {
    ok: boolean;
    error?: string;
    roles?: string[];
    scopes?: string[];
  };
  delegatedAuth?: {
    ok: boolean;
    error?: string;
    scopes?: string[];
    userPrincipalName?: string;
  };
};
//#endregion
//#region extensions/msteams/src/channel.d.ts
type ResolvedMSTeamsAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};
declare const msteamsPlugin: ChannelPlugin<ResolvedMSTeamsAccount, ProbeMSTeamsResult>;
//#endregion
export { msteamsPlugin as t };