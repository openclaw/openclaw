import { i as OpenClawConfig } from "./types.openclaw-C5VNg6h3.js";
import { n as HistoryMediaEntry } from "./history.types-r-Kl7uUF.js";
import { s as CommandNormalizeOptions } from "./commands-registry.types-Cbt5kNDp.js";
import { t as EnvelopeFormatOptions } from "./envelope-BoGes1bd.js";
import { n as createInboundDebouncer, t as InboundDebounceCreateParams } from "./inbound-debounce-B-oO9AWt.js";
import { x as InboundMediaFacts } from "./types-CSp-EgVU.js";
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
//#region src/channels/turn/media.d.ts
type ChannelTurnMediaInput = {
  path?: string | null;
  url?: string | null;
  contentType?: string | null;
  kind?: InboundMediaFacts["kind"] | null;
  transcribed?: boolean | null;
  messageId?: string | null;
};
type ChannelTurnMediaPayload = {
  MediaPath?: string;
  MediaUrl?: string;
  MediaType?: string;
  MediaPaths?: string[];
  MediaUrls?: string[];
  MediaTypes?: string[];
  MediaTranscribedIndexes?: number[];
};
declare function toInboundMediaFacts(media: readonly ChannelTurnMediaInput[] | null | undefined, defaults?: {
  kind?: InboundMediaFacts["kind"];
  messageId?: string;
  transcribed?: (media: ChannelTurnMediaInput, index: number) => boolean;
}): InboundMediaFacts[];
declare function toHistoryMediaEntries(media: readonly ChannelTurnMediaInput[] | null | undefined, defaults?: {
  kind?: InboundMediaFacts["kind"];
  messageId?: string;
}): HistoryMediaEntry[];
declare function buildChannelTurnMediaPayload(media: readonly InboundMediaFacts[] | null | undefined): ChannelTurnMediaPayload;
//#endregion
export { toInboundMediaFacts as a, shouldDebounceTextInbound as c, toHistoryMediaEntries as i, ChannelTurnMediaPayload as n, resolveInboundSessionEnvelopeContext as o, buildChannelTurnMediaPayload as r, createChannelInboundDebouncer as s, ChannelTurnMediaInput as t };