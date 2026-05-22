import { type WhatsAppReplyContext } from "../../identity.js";
import type { WebInboundMsg } from "../types.js";
export type GroupHistoryEntry = {
    sender: string;
    body: string;
    timestamp?: number;
    id?: string;
    senderJid?: string;
};
type ContextVisibilityMode = "all" | "allowlist" | "allowlist_quote";
export declare function resolveVisibleWhatsAppGroupHistory(params: {
    history: GroupHistoryEntry[];
    mode: ContextVisibilityMode;
    groupPolicy: "open" | "allowlist" | "disabled";
    groupAllowFrom: string[];
}): GroupHistoryEntry[];
export declare function resolveVisibleWhatsAppReplyContext(params: {
    msg: WebInboundMsg;
    authDir?: string;
    mode: ContextVisibilityMode;
    groupPolicy: "open" | "allowlist" | "disabled";
    groupAllowFrom: string[];
}): WhatsAppReplyContext | null;
export {};
