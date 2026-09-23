import type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";

type SharedPreflightFields =
  | "cfg"
  | "client"
  | "discordConfig"
  | "accountId"
  | "token"
  | "runtime"
  | "buildContext"
  | "botUserId"
  | "abortSignal"
  | "isPolicyCurrent"
  | "guildHistories"
  | "historyLimit"
  | "mediaMaxBytes"
  | "textLimit"
  | "replyToMode"
  | "ackReactionScope"
  | "groupPolicy"
  | "turnAdoptionLifecycle"
  | "threadBindings"
  | "discordRestFetch";

type BuildDiscordMessagePreflightContextParams = Omit<
  DiscordMessagePreflightContext,
  SharedPreflightFields
> & {
  preflightParams: DiscordMessagePreflightParams;
};

export function buildDiscordMessagePreflightContext({
  preflightParams,
  ...fields
}: BuildDiscordMessagePreflightContextParams): DiscordMessagePreflightContext {
  return {
    cfg: preflightParams.cfg,
    client: preflightParams.client,
    discordConfig: preflightParams.discordConfig,
    accountId: preflightParams.accountId,
    token: preflightParams.token,
    runtime: preflightParams.runtime,
    buildContext: preflightParams.buildContext,
    botUserId: preflightParams.botUserId,
    abortSignal: preflightParams.abortSignal,
    isPolicyCurrent: preflightParams.isPolicyCurrent,
    guildHistories: preflightParams.guildHistories,
    historyLimit: preflightParams.historyLimit,
    mediaMaxBytes: preflightParams.mediaMaxBytes,
    textLimit: preflightParams.textLimit,
    replyToMode: preflightParams.replyToMode,
    ackReactionScope: preflightParams.ackReactionScope,
    groupPolicy: preflightParams.groupPolicy,
    turnAdoptionLifecycle: preflightParams.turnAdoptionLifecycle,
    ...fields,
    threadBindings: preflightParams.threadBindings,
    discordRestFetch: preflightParams.discordRestFetch,
  };
}
