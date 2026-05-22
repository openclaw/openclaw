import { i as OpenClawConfig } from "./types.openclaw-D8bJSZjd.js";
import { n as InboundEventKind } from "./input-provenance-CQuRpA6_.js";
import { n as HistoryMediaEntry } from "./history.types-BMVHP-Fy.js";
import { s as CommandNormalizeOptions } from "./commands-registry.types-3bE8Hjrh.js";
import { t as EnvelopeFormatOptions } from "./envelope-4pltNxAh.js";
import { n as createInboundDebouncer, t as InboundDebounceCreateParams } from "./inbound-debounce-CBAeaWUp.js";
import { x as InboundMediaFacts, y as ConversationFacts } from "./types-RyDKb63i.js";
import { i as filterChannelInboundSupplementalContext, n as BuiltChannelInboundEventContext, t as BuildChannelInboundEventContextParams } from "./context-CgWm9DUU.js";
//#region src/channels/inbound-debounce-policy.d.ts
declare function shouldDebounceTextInbound(params: {
  text: string | null | undefined;
  cfg: OpenClawConfig;
  hasMedia?: boolean;
  commandOptions?: CommandNormalizeOptions;
  allowDebounce?: boolean;
}): boolean;
declare function createChannelInboundDebouncer<T>(params: Omit<InboundDebounceCreateParams<T>, "debounceMs"> & {
  cfg: OpenClawConfig;
  channel: string;
  debounceMsOverride?: number;
}): {
  debounceMs: number;
  debouncer: ReturnType<typeof createInboundDebouncer<T>>;
};
//#endregion
//#region src/channels/session-envelope.d.ts
declare function resolveInboundSessionEnvelopeContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): {
  storePath: string;
  envelopeOptions: EnvelopeFormatOptions;
  previousTimestamp: number | undefined;
};
//#endregion
//#region src/channels/inbound-event/classification.d.ts
type ClassifyChannelInboundEventParams = {
  conversation: Pick<ConversationFacts, "kind">;
  unmentionedGroupPolicy?: InboundEventKind;
  wasMentioned?: boolean;
  hasControlCommand?: boolean;
  hasAbortRequest?: boolean;
  commandSource?: "native" | "text";
};
declare function classifyChannelInboundEvent(params: ClassifyChannelInboundEventParams): InboundEventKind;
declare function resolveUnmentionedGroupInboundPolicy(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): InboundEventKind;
//#endregion
//#region src/channels/inbound-event/media.d.ts
type ChannelInboundMediaInput = {
  path?: string | null;
  url?: string | null;
  contentType?: string | null;
  kind?: InboundMediaFacts["kind"] | null;
  transcribed?: boolean | null;
  messageId?: string | null;
};
type ChannelInboundMediaPayload = {
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  MediaTranscribedIndexes?: number[];
};
declare function toInboundMediaFacts(media: readonly ChannelInboundMediaInput[] | null | undefined, defaults?: {
  kind?: InboundMediaFacts["kind"];
  messageId?: string;
  transcribed?: (media: ChannelInboundMediaInput, index: number) => boolean;
}): InboundMediaFacts[];
declare function toHistoryMediaEntries(media: readonly ChannelInboundMediaInput[] | null | undefined, defaults?: {
  kind?: InboundMediaFacts["kind"];
  messageId?: string;
}): HistoryMediaEntry[];
declare function buildChannelInboundMediaPayload(media: readonly InboundMediaFacts[] | null | undefined): ChannelInboundMediaPayload;
//#endregion
//#region src/plugin-sdk/channel-inbound.d.ts
type BuildChannelTurnContextParams = Omit<BuildChannelInboundEventContextParams, "message"> & {
  message: BuildChannelInboundEventContextParams["message"] & {
    inboundTurnKind?: InboundEventKind;
  };
};
type BuiltChannelTurnContext = BuiltChannelInboundEventContext & {
  InboundTurnKind: InboundEventKind;
};
declare function buildChannelTurnContext(params: BuildChannelTurnContextParams): BuiltChannelTurnContext;
declare const filterChannelTurnSupplementalContext: typeof filterChannelInboundSupplementalContext;
//#endregion
export { ChannelInboundMediaInput as a, toHistoryMediaEntries as c, classifyChannelInboundEvent as d, resolveUnmentionedGroupInboundPolicy as f, shouldDebounceTextInbound as h, filterChannelTurnSupplementalContext as i, toInboundMediaFacts as l, createChannelInboundDebouncer as m, BuiltChannelTurnContext as n, ChannelInboundMediaPayload as o, resolveInboundSessionEnvelopeContext as p, buildChannelTurnContext as r, buildChannelInboundMediaPayload as s, BuildChannelTurnContextParams as t, ClassifyChannelInboundEventParams as u };