// Msteams type declarations define plugin contracts.
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsMonitorLogger } from "./monitor-types.js";
import type { MSTeamsPollStore } from "./polls.js";
import type { MSTeamsApp } from "./sdk.js";

export type MSTeamsMessageHandlerDeps = {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  appId: string;
  app: MSTeamsApp;
  tokenProvider: MSTeamsAccessTokenProvider;
  textLimit: number;
  mediaMaxBytes: number;
  conversationStore: MSTeamsConversationStore;
  pollStore: MSTeamsPollStore;
  log: MSTeamsMonitorLogger;
};
