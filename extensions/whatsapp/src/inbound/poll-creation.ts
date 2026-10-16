// Finds the poll-creation section of a WhatsApp message across versions and wrappers.
import type { proto } from "baileys";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";

export type WhatsAppPollCreationVersion = "v1" | "v2" | "v3" | "v4" | "v5";

export type WhatsAppPollCreationMatch = {
  poll: proto.Message.IPollCreationMessage;
  version: WhatsAppPollCreationVersion;
  /** messageContextInfo of the poll layer first, then of each enclosing layer. */
  contextInfoLayers: proto.IMessageContextInfo[];
};

const POLL_SECTIONS = [
  ["pollCreationMessage", "v1"],
  ["pollCreationMessageV2", "v2"],
  ["pollCreationMessageV3", "v3"],
  ["pollCreationMessageV5", "v5"],
] as const;

// Envelopes whose `.message` carries the real content (Baileys normalizeMessageContent plus V4).
const WRAPPER_SECTIONS = [
  "pollCreationMessageV4",
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
  "editedMessage",
  "deviceSentMessage",
  "associatedChildMessage",
  "groupStatusMessage",
  "groupStatusMessageV2",
] as const;

const KNOWN_POLL_SECTION_NAMES = new Set<string>([
  ...POLL_SECTIONS.map(([name]) => name),
  "pollCreationMessageV4",
]);
const MAX_DEPTH = 6;

export function findWhatsAppPollCreation(
  message: proto.IMessage | null | undefined,
): WhatsAppPollCreationMatch | undefined {
  const layers: proto.IMessageContextInfo[] = [];
  let current = message ?? undefined;
  let wrappedInV4 = false;
  for (let depth = 0; current && depth < MAX_DEPTH; depth++) {
    if (current.messageContextInfo) {
      layers.unshift(current.messageContextInfo);
    }
    for (const [name, version] of POLL_SECTIONS) {
      const poll = current[name];
      if (poll) {
        return { poll, version: wrappedInV4 ? "v4" : version, contextInfoLayers: layers };
      }
    }
    let next: proto.IMessage | undefined;
    for (const wrapper of WRAPPER_SECTIONS) {
      const inner = current[wrapper]?.message;
      if (inner) {
        wrappedInV4 ||= wrapper === "pollCreationMessageV4";
        next = inner;
        break;
      }
    }
    if (!next) {
      const unknown = Object.keys(current).find(
        (key) => key.startsWith("pollCreationMessage") && !KNOWN_POLL_SECTION_NAMES.has(key),
      );
      if (unknown) {
        logVerbose(`whatsapp poll section not recognized: ${unknown}`);
      }
    }
    current = next;
  }
  return undefined;
}
