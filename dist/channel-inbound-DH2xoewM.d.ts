import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { s as CommandNormalizeOptions } from "./commands-registry.types-D_jauPV7.js";
import { t as EnvelopeFormatOptions } from "./envelope-C3zLks6g.js";
import { n as createInboundDebouncer, t as InboundDebounceCreateParams } from "./inbound-debounce-BFPf0MCS.js";
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
export { createChannelInboundDebouncer as n, shouldDebounceTextInbound as r, resolveInboundSessionEnvelopeContext as t };