import type { AcpRuntimeError } from "../../../acp/runtime/errors.js";
import type { AcpRuntimeSessionMode } from "../../../acp/runtime/types.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { AcpSessionRuntimeOptions } from "../../../config/sessions/types.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
export declare const COMMAND = "/acp";
export declare const ACP_SPAWN_USAGE = "Usage: /acp spawn [agentId] [--mode persistent|oneshot] [--thread auto|here|off] [--cwd <path>] [--label <label>].";
export declare const ACP_STEER_USAGE = "Usage: /acp steer [--session <session-key|session-id|session-label>] <instruction>";
export declare const ACP_SET_MODE_USAGE = "Usage: /acp set-mode <mode> [session-key|session-id|session-label]";
export declare const ACP_SET_USAGE = "Usage: /acp set <key> <value> [session-key|session-id|session-label]";
export declare const ACP_CWD_USAGE = "Usage: /acp cwd <path> [session-key|session-id|session-label]";
export declare const ACP_PERMISSIONS_USAGE = "Usage: /acp permissions <profile> [session-key|session-id|session-label]";
export declare const ACP_TIMEOUT_USAGE = "Usage: /acp timeout <seconds> [session-key|session-id|session-label]";
export declare const ACP_MODEL_USAGE = "Usage: /acp model <model-id> [session-key|session-id|session-label]";
export declare const ACP_RESET_OPTIONS_USAGE = "Usage: /acp reset-options [session-key|session-id|session-label]";
export declare const ACP_STATUS_USAGE = "Usage: /acp status [session-key|session-id|session-label]";
export declare const ACP_INSTALL_USAGE = "Usage: /acp install";
export declare const ACP_DOCTOR_USAGE = "Usage: /acp doctor";
export declare const ACP_SESSIONS_USAGE = "Usage: /acp sessions";
export declare const ACP_STEER_OUTPUT_LIMIT = 800;
export declare const SESSION_ID_RE: RegExp;
export type AcpAction = "spawn" | "cancel" | "steer" | "close" | "sessions" | "status" | "set-mode" | "set" | "cwd" | "permissions" | "timeout" | "model" | "reset-options" | "doctor" | "install" | "help";
export type AcpSpawnThreadMode = "auto" | "here" | "off";
export type ParsedSpawnInput = {
    agentId: string;
    mode: AcpRuntimeSessionMode;
    thread: AcpSpawnThreadMode;
    cwd?: string;
    label?: string;
};
export type ParsedSteerInput = {
    sessionToken?: string;
    instruction: string;
};
export type ParsedSingleValueCommandInput = {
    value: string;
    sessionToken?: string;
};
export type ParsedSetCommandInput = {
    key: string;
    value: string;
    sessionToken?: string;
};
export declare function stopWithText(text: string): CommandHandlerResult;
export declare function resolveAcpAction(tokens: string[]): AcpAction;
export declare function parseSpawnInput(params: HandleCommandsParams, tokens: string[]): {
    ok: true;
    value: ParsedSpawnInput;
} | {
    ok: false;
    error: string;
};
export declare function parseSteerInput(tokens: string[]): {
    ok: true;
    value: ParsedSteerInput;
} | {
    ok: false;
    error: string;
};
export declare function parseSingleValueCommandInput(tokens: string[], usage: string): {
    ok: true;
    value: ParsedSingleValueCommandInput;
} | {
    ok: false;
    error: string;
};
export declare function parseSetCommandInput(tokens: string[]): {
    ok: true;
    value: ParsedSetCommandInput;
} | {
    ok: false;
    error: string;
};
export declare function parseOptionalSingleTarget(tokens: string[], usage: string): {
    ok: true;
    sessionToken?: string;
} | {
    ok: false;
    error: string;
};
export declare function resolveAcpHelpText(): string;
export declare function resolveConfiguredAcpBackendId(cfg: OpenClawConfig): string;
export declare function resolveAcpInstallCommandHint(cfg: OpenClawConfig): string;
export declare function formatRuntimeOptionsText(options: AcpSessionRuntimeOptions): string;
export declare function formatAcpCapabilitiesText(controls: string[]): string;
export declare function resolveCommandRequestId(params: HandleCommandsParams): string;
export declare function collectAcpErrorText(params: {
    error: unknown;
    fallbackCode: AcpRuntimeError["code"];
    fallbackMessage: string;
}): string;
export declare function withAcpCommandErrorBoundary<T>(params: {
    run: () => Promise<T>;
    fallbackCode: AcpRuntimeError["code"];
    fallbackMessage: string;
    onSuccess: (value: T) => CommandHandlerResult;
}): Promise<CommandHandlerResult>;
