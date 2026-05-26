import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { a as TraceLevel, n as ReasoningLevel, o as VerboseLevel, r as ThinkLevel, t as ElevatedLevel } from "./thinking.shared-DZFlsfdo.js";
import { n as GetReplyOptions, o as TypingController, s as ReplyPayload } from "./get-reply-options.types-DiZecFJG.js";
import { a as BlockReplyChunking } from "./params-C8lj3xSa.js";
import { g as ExecAsk, v as ExecSecurity, y as ExecTarget } from "./exec-approvals-DZ3KhICc.js";
import { t as ChannelId } from "./channel-id.types-ClK6B_QE.js";
import { o as SessionEntry, s as SessionScope } from "./types-ChLEnNVH.js";
import { t as SkillCommandSpec } from "./skills-BRkHvK1T.js";
import { n as MsgContext } from "./templating-DbSpLCuR.js";
import { n as QueueMode, t as QueueDropPolicy } from "./types-uCPlO9gm.js";

//#region src/auto-reply/reply/directive-handling.parse.d.ts
type InlineDirectives = {
  cleaned: string;
  hasThinkDirective: boolean;
  thinkLevel?: ThinkLevel;
  rawThinkLevel?: string;
  clearThinkLevel: boolean;
  hasVerboseDirective: boolean;
  verboseLevel?: VerboseLevel;
  rawVerboseLevel?: string;
  hasTraceDirective: boolean;
  traceLevel?: TraceLevel;
  rawTraceLevel?: string;
  hasFastDirective: boolean;
  fastMode?: boolean;
  rawFastMode?: string;
  clearFastMode: boolean;
  hasReasoningDirective: boolean;
  reasoningLevel?: ReasoningLevel;
  rawReasoningLevel?: string;
  hasElevatedDirective: boolean;
  elevatedLevel?: ElevatedLevel;
  rawElevatedLevel?: string;
  hasExecDirective: boolean;
  execHost?: ExecTarget;
  execSecurity?: ExecSecurity;
  execAsk?: ExecAsk;
  execNode?: string;
  rawExecHost?: string;
  rawExecSecurity?: string;
  rawExecAsk?: string;
  rawExecNode?: string;
  hasExecOptions: boolean;
  invalidExecHost: boolean;
  invalidExecSecurity: boolean;
  invalidExecAsk: boolean;
  invalidExecNode: boolean;
  hasStatusDirective: boolean;
  hasModelDirective: boolean;
  rawModelDirective?: string;
  rawModelProfile?: string;
  rawModelRuntime?: string;
  hasQueueDirective: boolean;
  queueMode?: QueueMode;
  queueReset: boolean;
  rawQueueMode?: string;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: QueueDropPolicy;
  rawDebounce?: string;
  rawCap?: string;
  rawDrop?: string;
  hasQueueOptions: boolean;
};
//#endregion
//#region src/auto-reply/reply/commands-types.d.ts
type CommandContext = {
  surface: string;
  channel: string;
  channelId?: ChannelId;
  ownerList: string[];
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  senderId?: string;
  abortKey?: string;
  rawBodyNormalized: string;
  commandBodyNormalized: string;
  from?: string;
  to?: string; /** Internal marker to prevent duplicate reset-hook emission across command pipelines. */
  resetHookTriggered?: boolean; /** Internal marker for prompt reload without session rollover. */
  softResetTriggered?: boolean; /** Optional tail to append after a soft reset startup prompt. */
  softResetTail?: string;
};
type HandleCommandsParams = {
  ctx: MsgContext;
  rootCtx?: MsgContext;
  cfg: OpenClawConfig;
  command: CommandContext;
  agentId?: string;
  agentDir?: string;
  directives: InlineDirectives;
  elevated: {
    enabled: boolean;
    allowed: boolean;
    failures: Array<{
      gate: string;
      key: string;
    }>;
  };
  sessionEntry?: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  sessionScope?: SessionScope;
  workspaceDir: string;
  opts?: GetReplyOptions;
  defaultGroupActivation: () => "always" | "mention";
  resolvedThinkLevel?: ThinkLevel;
  resolvedFastMode?: boolean;
  resolvedVerboseLevel: VerboseLevel;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  blockReplyChunking?: BlockReplyChunking;
  resolvedBlockStreamingBreak?: "text_end" | "message_end";
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  provider: string;
  model: string;
  contextTokens: number;
  isGroup: boolean;
  skillCommands?: SkillCommandSpec[];
  typing?: TypingController;
};
type CommandHandlerResult = {
  reply?: ReplyPayload;
  shouldContinue: boolean;
};
type CommandHandler = (params: HandleCommandsParams, allowTextCommands: boolean) => Promise<CommandHandlerResult | null>;
//#endregion
export { CommandHandler as n, HandleCommandsParams as r, CommandContext as t };