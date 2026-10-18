import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import type {
  CoreConfig,
  MatrixConfig,
  MatrixRoomConfig,
  MatrixStreamingMode,
  ReplyToMode,
} from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import type { MatrixResolvedAllowlistEntry } from "./config.js";
import type { createDirectRoomTracker } from "./direct.js";
import type { MatrixInboundEventDeduper } from "./inbound-dedupe.js";

export type MatrixMonitorHandlerParams = {
  client: MatrixClient;
  core: PluginRuntime;
  cfg: CoreConfig;
  accountId: string;
  accountConfig?: MatrixConfig;
  runtime: RuntimeEnv;
  logger: RuntimeLogger;
  logVerboseMessage: (message: string) => void;
  allowFrom: string[];
  allowFromResolvedEntries?: readonly MatrixResolvedAllowlistEntry[];
  groupAllowFrom?: string[];
  groupAllowFromResolvedEntries?: readonly MatrixResolvedAllowlistEntry[];
  roomsConfig?: Record<string, MatrixRoomConfig>;
  accountAllowBots?: boolean | "mentions";
  configuredBotUserIds?: ReadonlySet<string>;
  groupPolicy: "open" | "allowlist" | "disabled";
  replyToMode: ReplyToMode;
  threadReplies: "off" | "inbound" | "always";
  /** DM-specific threadReplies override. Falls back to threadReplies when absent. */
  dmThreadReplies?: "off" | "inbound" | "always";
  /** DM session grouping behavior. */
  dmSessionScope?: "per-user" | "per-room";
  streaming: MatrixStreamingMode;
  previewToolProgressEnabled: boolean;
  blockStreamingEnabled: boolean;
  dmEnabled: boolean;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  mediaMaxBytes: number;
  historyLimit: number;
  startupMs: number;
  dropPreStartupMessages: boolean;
  inboundDeduper?: Pick<MatrixInboundEventDeduper, "claim">;
  directTracker: Pick<ReturnType<typeof createDirectRoomTracker>, "isDirectMessage">;
  getRoomInfo: (
    roomId: string,
    opts?: { includeAliases?: boolean },
  ) => Promise<{ name?: string; canonicalAlias?: string; altAliases: string[] }>;
  getMemberDisplayName: (roomId: string, userId: string) => Promise<string>;
  needsRoomAliasesForConfig: boolean;
};

export type MatrixHandlerRuntimeConfig = MatrixMonitorHandlerParams & {
  allowFromResolvedEntries: readonly MatrixResolvedAllowlistEntry[];
  groupAllowFromResolvedEntries: readonly MatrixResolvedAllowlistEntry[];
  configuredBotUserIds: ReadonlySet<string>;
};
