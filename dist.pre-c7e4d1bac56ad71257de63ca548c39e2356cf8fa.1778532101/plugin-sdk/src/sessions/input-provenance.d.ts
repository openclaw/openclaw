import type { AgentMessage } from "@mariozechner/pi-agent-core";
export declare const INPUT_PROVENANCE_KIND_VALUES: readonly ["external_user", "inter_session", "internal_system"];
export type InputProvenanceKind = (typeof INPUT_PROVENANCE_KIND_VALUES)[number];
export type InputProvenance = {
    kind: InputProvenanceKind;
    originSessionId?: string;
    sourceSessionKey?: string;
    sourceChannel?: string;
    sourceTool?: string;
};
export declare const INTER_SESSION_PROMPT_PREFIX_BASE = "[Inter-session message]";
export declare function normalizeInputProvenance(value: unknown): InputProvenance | undefined;
export declare function applyInputProvenanceToUserMessage(message: AgentMessage, inputProvenance: InputProvenance | undefined): AgentMessage;
export declare function isInterSessionInputProvenance(value: unknown): boolean;
export declare function hasInterSessionUserProvenance(message: {
    role?: unknown;
    provenance?: unknown;
} | undefined): boolean;
export declare function buildInterSessionPromptPrefix(inputProvenance: InputProvenance | undefined): string;
export declare function annotateInterSessionPromptText(text: string, inputProvenance: InputProvenance | undefined): string;
