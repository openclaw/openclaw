import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import type { WorkspaceBootstrapFile } from "../workspace.js";
import type { EmbeddedContextFile } from "./types.js";
type ThoughtSignatureSanitizeOptions = {
    allowBase64Only?: boolean;
    includeCamelCase?: boolean;
};
/**
 * Strips Claude-style thought_signature fields from content blocks.
 *
 * Gemini expects thought signatures as base64-encoded bytes, but Claude stores message ids
 * like "msg_abc123...". We only strip "msg_*" to preserve any provider-valid signatures.
 */
export declare function stripThoughtSignatures<T>(content: T, options?: ThoughtSignatureSanitizeOptions): T;
export declare const DEFAULT_BOOTSTRAP_MAX_CHARS = 20000;
export declare const DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 150000;
export declare function resolveBootstrapMaxChars(cfg?: OpenClawConfig): number;
export declare function resolveBootstrapTotalMaxChars(cfg?: OpenClawConfig): number;
export declare function ensureSessionHeader(params: {
    sessionFile: string;
    sessionId: string;
    cwd: string;
}): Promise<void>;
export declare function buildBootstrapContextFiles(files: WorkspaceBootstrapFile[], opts?: {
    warn?: (message: string) => void;
    maxChars?: number;
    totalMaxChars?: number;
}): EmbeddedContextFile[];
export declare function sanitizeGoogleTurnOrdering(messages: AgentMessage[]): AgentMessage[];
export {};
