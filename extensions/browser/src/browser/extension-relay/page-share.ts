import { requestHeartbeat } from "openclaw/plugin-sdk/heartbeat-runtime";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import {
  enqueueSystemEvent,
  resolveMainSessionKeyFromConfig,
} from "openclaw/plugin-sdk/system-event-runtime";
import type { PageSharePayload } from "./relay-protocol.js";

export const PAGE_SHARE_GATEWAY_REQUIRED_ERROR =
  "Send to OpenClaw needs the extension relay hosted by the Gateway (pair on the Gateway host or use direct Gateway pairing). Node-hosted relays are not supported yet.";

export type PageShareSink = {
  enqueueSystemEvent(text: string, opts: { sessionKey: string }): unknown;
  requestHeartbeat(opts: { source: "other"; intent: "immediate"; reason: string }): unknown;
  resolveMainSessionKey(): string;
};

let pageShareSink: PageShareSink | null = null;

export function setPageShareSink(sink: PageShareSink | null): void {
  // Sink presence marks a Gateway process with the main agent loop. Node-hosted
  // relays never set it, preventing page shares from black-holing there.
  pageShareSink = sink;
}

export function createGatewayPageShareSink(): PageShareSink {
  return {
    enqueueSystemEvent,
    requestHeartbeat,
    resolveMainSessionKey: resolveMainSessionKeyFromConfig,
  };
}

export async function deliverPageShare(payload: PageSharePayload): Promise<void> {
  const sink = pageShareSink;
  if (!sink) {
    throw new Error(PAGE_SHARE_GATEWAY_REQUIRED_ERROR);
  }

  const note = payload.note?.trim();
  const body = payload.selection?.trim() || payload.content;
  const header = [
    `Page shared from the OpenClaw Chrome extension: ${payload.title}`,
    `URL: ${payload.url}`,
    ...(note ? [`Note: ${note}`] : []),
  ].join("\n");
  const text = `${header}\n\n${wrapExternalContent(body, { source: "browser" })}`;

  await sink.enqueueSystemEvent(text, { sessionKey: sink.resolveMainSessionKey() });
  await sink.requestHeartbeat({
    source: "other",
    intent: "immediate",
    reason: "browser-page-share",
  });
}
