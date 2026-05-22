import type { proto } from "baileys";
import { type NormalizedLocation } from "openclaw/plugin-sdk/channel-inbound";
import { type WhatsAppReplyContext } from "../identity.js";
import type { WhatsAppStructuredContactContext } from "./types.js";
export declare function extractContextInfo(message: proto.IMessage | undefined): proto.IContextInfo | undefined;
export declare function extractMentionedJids(rawMessage: proto.IMessage | undefined): string[] | undefined;
export declare function extractText(rawMessage: proto.IMessage | undefined): string | undefined;
export declare function extractMediaPlaceholder(rawMessage: proto.IMessage | undefined): string | undefined;
export declare function extractContactContext(rawMessage: proto.IMessage | undefined): WhatsAppStructuredContactContext | undefined;
export declare function extractLocationData(rawMessage: proto.IMessage | undefined): NormalizedLocation | null;
export declare function describeReplyContext(rawMessage: proto.IMessage | undefined): WhatsAppReplyContext | null;
/**
 * Fast check that a Baileys message carries user-visible inbound content
 * (text, media, contact, location, button/list selection). Returns false for
 * protocol/receipt/typing notifications that arrive on the same
 * `messages.upsert` stream as real messages but should not trigger pairing
 * access-control side effects.
 */
export declare function hasInboundUserContent(rawMessage: proto.IMessage | undefined): boolean;
