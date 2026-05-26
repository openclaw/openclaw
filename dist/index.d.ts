import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { u as loadConfig$1 } from "./io-QWYwWbjN.js";
import { f as loadSessionStore$1, o as saveSessionStore$1, v as resolveStorePath$1 } from "./store-hrETKlw2.js";
import { r as applyTemplate$1 } from "./templating-DbSpLCuR.js";
import { a as runCommandWithTimeout$2, o as runExec$2 } from "./exec-BGPm1RPN.js";
import { n as RuntimeEnv } from "./runtime-Bxifh4bY.js";
import { n as PollInput } from "./polls-CfHkU59X.js";
import { l as normalizeE164$1 } from "./utils-DSrjARXN.js";
import { n as resolveSessionKey$1, t as deriveSessionKey$1 } from "./session-key-Dp9I3l7z.js";
import { t as CliDeps } from "./deps.types-C8BV1CgG.js";
import { i as handlePortError$1, n as describePortOwner$1, r as ensurePortAvailable$1, t as PortInUseError$1 } from "./ports-DqReeIZ2.js";
import { t as waitForever$1 } from "./wait-isUfz79Z.js";
import { t as getReplyFromConfig$2 } from "./get-reply-2GvKLvkm.js";
import { AgentToolResult } from "@earendil-works/pi-agent-core";

//#region src/cli/prompt.d.ts
declare function promptYesNo$2(question: string, defaultYes?: boolean): Promise<boolean>;
//#endregion
//#region src/cli/deps.d.ts
declare function createDefaultDeps$1(): CliDeps;
//#endregion
//#region src/infra/binaries.d.ts
declare function ensureBinary$2(name: string, exec?: typeof runExec$2, runtime?: RuntimeEnv): Promise<void>;
//#endregion
//#region src/plugins/runtime/runtime-web-channel-plugin.d.ts
type WebChannelHeavyRuntimeModule = {
  loginWeb: (verbose: boolean, waitForConnection?: (sock: unknown) => Promise<void>, runtime?: unknown, accountId?: string) => Promise<void>;
  sendMessageWhatsApp: (to: string, body: string, options: {
    verbose: boolean;
    cfg?: OpenClawConfig;
    mediaUrl?: string;
    mediaAccess?: {
      localRoots?: readonly string[];
      readFile?: (filePath: string) => Promise<Buffer>;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    gifPlayback?: boolean;
    accountId?: string;
  }) => Promise<{
    messageId: string;
    toJid: string;
  }>;
  sendPollWhatsApp: (to: string, poll: PollInput, options: {
    verbose: boolean;
    accountId?: string;
    cfg?: OpenClawConfig;
  }) => Promise<{
    messageId: string;
    toJid: string;
  }>;
  sendReactionWhatsApp: (chatJid: string, messageId: string, emoji: string, options: {
    verbose: boolean;
    fromMe?: boolean;
    participant?: string;
    accountId?: string;
  }) => Promise<void>;
  createWaSocket: (printQr: boolean, verbose: boolean, opts?: {
    authDir?: string;
    onQr?: (qr: string) => void;
  }) => Promise<unknown>;
  handleWhatsAppAction: (params: Record<string, unknown>, cfg: OpenClawConfig) => Promise<AgentToolResult<unknown>>;
  monitorWebChannel: (...args: unknown[]) => Promise<unknown>;
  monitorWebInbox: (...args: unknown[]) => Promise<unknown>;
  startWebLoginWithQr: (...args: unknown[]) => Promise<unknown>;
  waitForWaConnection: (sock: unknown) => Promise<void>;
  waitForWebLogin: (...args: unknown[]) => Promise<unknown>;
  extractMediaPlaceholder: (...args: unknown[]) => unknown;
  extractText: (...args: unknown[]) => unknown;
};
declare function monitorWebChannel$2(...args: Parameters<WebChannelHeavyRuntimeModule["monitorWebChannel"]>): ReturnType<WebChannelHeavyRuntimeModule["monitorWebChannel"]>;
declare namespace library_d_exports {
  export { PortInUseError$1 as PortInUseError, applyTemplate$1 as applyTemplate, createDefaultDeps$1 as createDefaultDeps, deriveSessionKey$1 as deriveSessionKey, describePortOwner$1 as describePortOwner, ensureBinary$1 as ensureBinary, ensurePortAvailable$1 as ensurePortAvailable, getReplyFromConfig$1 as getReplyFromConfig, handlePortError$1 as handlePortError, loadConfig$1 as loadConfig, loadSessionStore$1 as loadSessionStore, monitorWebChannel$1 as monitorWebChannel, normalizeE164$1 as normalizeE164, promptYesNo$1 as promptYesNo, resolveSessionKey$1 as resolveSessionKey, resolveStorePath$1 as resolveStorePath, runCommandWithTimeout$1 as runCommandWithTimeout, runExec$1 as runExec, saveSessionStore$1 as saveSessionStore, waitForever$1 as waitForever };
}
type GetReplyFromConfig = typeof getReplyFromConfig$2;
type PromptYesNo = typeof promptYesNo$2;
type EnsureBinary = typeof ensureBinary$2;
type RunExec = typeof runExec$2;
type RunCommandWithTimeout = typeof runCommandWithTimeout$2;
type MonitorWebChannel = typeof monitorWebChannel$2;
declare const getReplyFromConfig$1: GetReplyFromConfig;
declare const promptYesNo$1: PromptYesNo;
declare const ensureBinary$1: EnsureBinary;
declare const runExec$1: RunExec;
declare const runCommandWithTimeout$1: RunCommandWithTimeout;
declare const monitorWebChannel$1: MonitorWebChannel;
//#endregion
//#region src/index.d.ts
type LegacyCliDeps = {
  runCli: (argv: string[]) => Promise<void>;
};
type LibraryExports = typeof library_d_exports;
declare let applyTemplate: LibraryExports["applyTemplate"];
declare let createDefaultDeps: LibraryExports["createDefaultDeps"];
declare let deriveSessionKey: LibraryExports["deriveSessionKey"];
declare let describePortOwner: LibraryExports["describePortOwner"];
declare let ensureBinary: LibraryExports["ensureBinary"];
declare let ensurePortAvailable: LibraryExports["ensurePortAvailable"];
declare let getReplyFromConfig: LibraryExports["getReplyFromConfig"];
declare let handlePortError: LibraryExports["handlePortError"];
declare let loadConfig: LibraryExports["loadConfig"];
declare let loadSessionStore: LibraryExports["loadSessionStore"];
declare let monitorWebChannel: LibraryExports["monitorWebChannel"];
declare let normalizeE164: LibraryExports["normalizeE164"];
declare let PortInUseError: LibraryExports["PortInUseError"];
declare let promptYesNo: LibraryExports["promptYesNo"];
declare let resolveSessionKey: LibraryExports["resolveSessionKey"];
declare let resolveStorePath: LibraryExports["resolveStorePath"];
declare let runCommandWithTimeout: LibraryExports["runCommandWithTimeout"];
declare let runExec: LibraryExports["runExec"];
declare let saveSessionStore: LibraryExports["saveSessionStore"];
declare let waitForever: LibraryExports["waitForever"];
declare function runLegacyCliEntry(argv?: string[], deps?: LegacyCliDeps): Promise<void>;
//#endregion
export { PortInUseError, applyTemplate, createDefaultDeps, deriveSessionKey, describePortOwner, ensureBinary, ensurePortAvailable, getReplyFromConfig, handlePortError, loadConfig, loadSessionStore, monitorWebChannel, normalizeE164, promptYesNo, resolveSessionKey, resolveStorePath, runCommandWithTimeout, runExec, runLegacyCliEntry, saveSessionStore, waitForever };