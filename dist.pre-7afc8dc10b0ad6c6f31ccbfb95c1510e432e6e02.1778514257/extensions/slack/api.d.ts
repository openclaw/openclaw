import { i as OpenClawConfig } from "../../types.openclaw-C9E_zZnO.js";
import { B as ChannelThreadingToolContext, V as ChannelToolSend, z as ChannelThreadingContext } from "../../types.core-gexONR-2.js";
import { t as ChannelMessageActionName } from "../../types.public-D_xOTs5v.js";
import { t as AllowlistMatch } from "../../allowlist-match-BAdcwbAA.js";
import { a as mergeSlackAccountConfig, c as resolveSlackReplyToMode, i as listSlackAccountIds, n as SlackTokenSource, o as resolveDefaultSlackAccountId, r as listEnabledSlackAccounts, s as resolveSlackAccount, t as ResolvedSlackAccount } from "../../accounts-ClUjHerM.js";
import { a as normalizeSlackMessagingTarget, i as looksLikeSlackTargetId, n as SlackTargetKind, o as parseSlackTarget, r as SlackTargetParseOptions, s as resolveSlackChannelId, t as SlackTarget } from "../../runtime-api-D5eQZObS.js";
import { n as SlackCredentialStatus, r as inspectSlackAccount, t as InspectedSlackAccount } from "../../account-inspect-D1i_k07g.js";
import { n as probeSlack, t as SlackProbe } from "../../probe-xLA1JWK-.js";
import { t as slackPlugin } from "../../channel-CiG_3xyP.js";
import { t as slackSetupPlugin } from "../../channel.setup-CRgLG7Lh.js";
import { _ as removeOwnSlackReactions, a as SlackMessageSummary, b as unpinSlackMessage, c as downloadSlackFile, d as listSlackEmojis, f as listSlackPins, g as readSlackMessages, h as reactSlackMessage, i as SlackActionClientOpts, l as editSlackMessage, m as pinSlackMessage, n as parseSlackBlocksInput, o as SlackPin, p as listSlackReactions, r as validateSlackBlocksArray, s as deleteSlackMessage, t as SLACK_MAX_BLOCKS, u as getSlackMemberInfo, v as removeSlackReaction, y as sendSlackMessage } from "../../blocks-input-2u2litgz.js";
import { d as SlackBlock, f as buildSlackInteractiveBlocks, l as resolveSlackGroupRequireMention, n as resolveSlackRuntimeGroupPolicy, p as buildSlackPresentationBlocks, u as resolveSlackGroupToolPolicy } from "../../provider-BhTJxfUU.js";
import { n as listSlackDirectoryPeersFromConfig, t as listSlackDirectoryGroupsFromConfig } from "../../directory-config-DeAN_p5e.js";
import { n as SlackInteractiveHandlerRegistration, t as SlackInteractiveHandlerContext } from "../../interactive-dispatch-Dw1T-rtM.js";
import { n as isSlackInteractiveRepliesEnabled, r as parseSlackOptionsLine, t as compileSlackInteractiveReplies } from "../../interactive-replies-BjNhFneI.js";
import { t as collectSlackSecurityAuditFindings } from "../../security-audit-DA1vFgS7.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { RetryOptions, WebClient, WebClientOptions } from "@slack/web-api";

//#region extensions/slack/src/action-threading.d.ts
declare function resolveSlackAutoThreadId(params: {
  to: string;
  toolContext?: {
    currentChannelId?: string;
    currentThreadTs?: string;
    replyToMode?: "off" | "first" | "all" | "batched";
    hasRepliedRef?: {
      value: boolean;
    };
  };
}): string | undefined;
//#endregion
//#region extensions/slack/src/channel-type.d.ts
declare function resolveSlackChannelType(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  channelId: string;
}): Promise<"channel" | "group" | "dm" | "unknown">;
declare function __resetSlackChannelTypeCacheForTest(): void;
//#endregion
//#region extensions/slack/src/client-options.d.ts
declare const SLACK_DEFAULT_RETRY_OPTIONS: RetryOptions;
declare const SLACK_WRITE_RETRY_OPTIONS: RetryOptions;
declare function resolveSlackWebClientOptions(options?: WebClientOptions): WebClientOptions;
declare function resolveSlackWriteClientOptions(options?: WebClientOptions): WebClientOptions;
//#endregion
//#region extensions/slack/src/client.d.ts
declare function createSlackWebClient(token: string, options?: WebClientOptions): WebClient;
declare function createSlackWriteClient(token: string, options?: WebClientOptions): WebClient;
declare function createSlackTokenCacheKey(token: string): string;
declare function getSlackWriteClient(token: string): WebClient;
declare function clearSlackWriteClientCacheForTest(): void;
//#endregion
//#region extensions/slack/src/http/paths.d.ts
declare function normalizeSlackWebhookPath(path?: string | null): string;
//#endregion
//#region extensions/slack/src/http/registry.d.ts
type SlackHttpRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
type RegisterSlackHttpHandlerArgs = {
  path?: string | null;
  handler: SlackHttpRequestHandler;
  log?: (message: string) => void;
  accountId?: string;
};
declare function registerSlackHttpHandler(params: RegisterSlackHttpHandlerArgs): () => void;
declare function handleSlackHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
//#endregion
//#region extensions/slack/src/message-actions.d.ts
declare function listSlackMessageActions(cfg: OpenClawConfig, accountId?: string | null): ChannelMessageActionName[];
declare function extractSlackToolSend(args: Record<string, unknown>): ChannelToolSend | null;
//#endregion
//#region extensions/slack/src/monitor/allow-list.d.ts
declare function normalizeSlackSlug(raw?: string): string;
declare function normalizeAllowList(list?: Array<string | number>): string[];
declare function normalizeAllowListLower(list?: Array<string | number>): string[];
declare function normalizeSlackAllowOwnerEntry(entry: string): string | undefined;
type SlackAllowListMatch = AllowlistMatch<"wildcard" | "id" | "prefixed-id" | "prefixed-user" | "name" | "prefixed-name" | "slug">;
declare function resolveSlackAllowListMatch(params: {
  allowList: string[];
  id?: string;
  name?: string;
  allowNameMatching?: boolean;
}): SlackAllowListMatch;
declare function allowListMatches(params: {
  allowList: string[];
  id?: string;
  name?: string;
  allowNameMatching?: boolean;
}): boolean;
declare function resolveSlackUserAllowed(params: {
  allowList?: Array<string | number>;
  userId?: string;
  userName?: string;
  allowNameMatching?: boolean;
}): boolean;
//#endregion
//#region extensions/slack/src/sent-thread-cache.d.ts
declare function recordSlackThreadParticipation(accountId: string, channelId: string, threadTs: string, opts?: {
  agentId?: string;
}): void;
declare function hasSlackThreadParticipation(accountId: string, channelId: string, threadTs: string): boolean;
declare function clearSlackThreadParticipationCache(): void;
//#endregion
//#region extensions/slack/src/threading-tool-context.d.ts
declare function buildSlackThreadingToolContext(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  context: ChannelThreadingContext;
  hasRepliedRef?: {
    value: boolean;
  };
}): ChannelThreadingToolContext;
//#endregion
export { type InspectedSlackAccount, type ResolvedSlackAccount, SLACK_DEFAULT_RETRY_OPTIONS, SLACK_MAX_BLOCKS, SLACK_WRITE_RETRY_OPTIONS, type SlackActionClientOpts, type SlackAllowListMatch, type SlackBlock, type SlackCredentialStatus, type SlackHttpRequestHandler, type SlackInteractiveHandlerContext, type SlackInteractiveHandlerRegistration, type SlackMessageSummary, type SlackPin, type SlackProbe, type SlackTarget, type SlackTargetKind, type SlackTargetParseOptions, type SlackTokenSource, __resetSlackChannelTypeCacheForTest, allowListMatches, buildSlackInteractiveBlocks, buildSlackPresentationBlocks, buildSlackThreadingToolContext, clearSlackThreadParticipationCache, clearSlackWriteClientCacheForTest, collectSlackSecurityAuditFindings, compileSlackInteractiveReplies, createSlackTokenCacheKey, createSlackWebClient, createSlackWriteClient, deleteSlackMessage, downloadSlackFile, editSlackMessage, extractSlackToolSend, getSlackMemberInfo, getSlackWriteClient, handleSlackHttpRequest, hasSlackThreadParticipation, inspectSlackAccount, isSlackInteractiveRepliesEnabled, listEnabledSlackAccounts, listSlackAccountIds, listSlackDirectoryGroupsFromConfig, listSlackDirectoryPeersFromConfig, listSlackEmojis, listSlackMessageActions, listSlackPins, listSlackReactions, looksLikeSlackTargetId, mergeSlackAccountConfig, normalizeAllowList, normalizeAllowListLower, normalizeSlackAllowOwnerEntry, normalizeSlackMessagingTarget, normalizeSlackSlug, normalizeSlackWebhookPath, parseSlackBlocksInput, parseSlackOptionsLine, parseSlackTarget, pinSlackMessage, probeSlack, reactSlackMessage, readSlackMessages, recordSlackThreadParticipation, registerSlackHttpHandler, removeOwnSlackReactions, removeSlackReaction, resolveDefaultSlackAccountId, resolveSlackAccount, resolveSlackAllowListMatch, resolveSlackAutoThreadId, resolveSlackChannelId, resolveSlackChannelType, resolveSlackGroupRequireMention, resolveSlackGroupToolPolicy, resolveSlackReplyToMode, resolveSlackRuntimeGroupPolicy, resolveSlackUserAllowed, resolveSlackWebClientOptions, resolveSlackWriteClientOptions, sendSlackMessage, slackPlugin, slackSetupPlugin, unpinSlackMessage, validateSlackBlocksArray };