import { H as TypingMode } from "../../types.base-YD5s4YZy.js";
import { o as VerboseLevel } from "../../thinking.shared-C-reoE5U.js";
import { o as SessionEntry } from "../../types-Drxj2JTH.js";
import { w as ReplyOperation } from "../../params-D0fLulcl.js";
import { l as TypingController, r as GetReplyOptions, u as ReplyPayload } from "../../get-reply-options.types-qXtysYg7.js";
import { i as TemplateContext } from "../../templating-Bgc3zJgd.js";
import { i as QueueSettings, t as FollowupRun } from "../../types-c_z-uBhE.js";
//#region src/auto-reply/reply/agent-runner.d.ts
declare function runReplyAgent(params: {
  commandBody: string;
  transcriptCommandBody?: string;
  followupRun: FollowupRun;
  queueKey: string;
  resolvedQueue: QueueSettings;
  shouldSteer: boolean;
  shouldFollowup: boolean;
  isActive: boolean;
  isRunActive?: () => boolean;
  isStreaming: boolean;
  opts?: GetReplyOptions;
  typing: TypingController;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  storePath?: string;
  defaultModel: string;
  agentCfgContextTokens?: number;
  resolvedVerboseLevel: VerboseLevel;
  toolProgressDetail?: "explain" | "raw";
  isNewSession: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  sessionCtx: TemplateContext;
  shouldInjectGroupIntro: boolean;
  typingMode: TypingMode; /** True when this turn was triggered by a continuation timer (detected before system events are drained). */
  isContinuationWake?: boolean;
  resetTriggered?: boolean;
  replyThreadingOverride?: TemplateContext["ReplyThreading"];
  replyOperation?: ReplyOperation;
}): Promise<ReplyPayload | ReplyPayload[] | undefined>;
//#endregion
export { runReplyAgent };