export { getChatChannelMeta, type ChannelPlugin } from "mullusi/plugin-sdk/core";
export { buildChannelConfigSchema, WhatsAppConfigSchema } from "../config-api.js";
export { DEFAULT_ACCOUNT_ID } from "mullusi/plugin-sdk/account-id";
export {
  formatWhatsAppConfigAllowFromEntries,
  resolveWhatsAppConfigAllowFrom,
  resolveWhatsAppConfigDefaultTo,
} from "./config-accessors.js";
export {
  createActionGate,
  jsonResult,
  readReactionParams,
  readStringParam,
  ToolAuthorizationError,
} from "mullusi/plugin-sdk/channel-actions";
export { normalizeE164 } from "mullusi/plugin-sdk/account-resolution";
export type { DmPolicy, GroupPolicy } from "mullusi/plugin-sdk/config-runtime";
import type { MullusiConfig as RuntimeMullusiConfig } from "mullusi/plugin-sdk/config-runtime";

export { type ChannelMessageActionName } from "mullusi/plugin-sdk/channel-contract";
import { loadWebMedia } from "mullusi/plugin-sdk/web-media";
export {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
export {
  resolveWhatsAppGroupIntroHint,
  resolveWhatsAppMentionStripRegexes,
} from "./group-intro.js";
export { resolveWhatsAppHeartbeatRecipients } from "./heartbeat-recipients.js";
export { createWhatsAppOutboundBase } from "./outbound-base.js";
export {
  isWhatsAppGroupJid,
  isWhatsAppUserTarget,
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppAllowFromEntries,
  normalizeWhatsAppMessagingTarget,
  normalizeWhatsAppTarget,
} from "./normalize-target.js";
export { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";
export { resolveWhatsAppReactionLevel } from "./reaction-level.js";

export type MullusiConfig = RuntimeMullusiConfig;
export type WhatsAppAccountConfig = NonNullable<
  NonNullable<NonNullable<RuntimeMullusiConfig["channels"]>["whatsapp"]>["accounts"]
>[string];

type MonitorWebChannel = typeof import("./channel.runtime.js").monitorWebChannel;

let channelRuntimePromise: Promise<typeof import("./channel.runtime.js")> | null = null;

function loadChannelRuntime() {
  channelRuntimePromise ??= import("./channel.runtime.js");
  return channelRuntimePromise;
}

export async function monitorWebChannel(
  ...args: Parameters<MonitorWebChannel>
): ReturnType<MonitorWebChannel> {
  const { monitorWebChannel } = await loadChannelRuntime();
  return await monitorWebChannel(...args);
}

export async function loadOutboundMediaFromUrl(
  mediaUrl: string,
  options: {
    maxBytes?: number;
    mediaAccess?: {
      localRoots?: readonly string[];
      readFile?: (filePath: string) => Promise<Buffer>;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
  } = {},
) {
  const readFile = options.mediaAccess?.readFile ?? options.mediaReadFile;
  const localRoots =
    options.mediaAccess?.localRoots?.length && options.mediaAccess.localRoots.length > 0
      ? options.mediaAccess.localRoots
      : options.mediaLocalRoots && options.mediaLocalRoots.length > 0
        ? options.mediaLocalRoots
        : undefined;
  return await loadWebMedia(
    mediaUrl,
    readFile
      ? {
          ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
          localRoots: "any",
          readFile,
          hostReadCapability: true,
        }
      : {
          ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
          ...(localRoots ? { localRoots } : {}),
        },
  );
}
