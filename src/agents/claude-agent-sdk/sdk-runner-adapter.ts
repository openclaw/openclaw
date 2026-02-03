/**
 * Adapter that wraps the SDK runner to produce results compatible with
 * the Pi Agent embedded runner result type.
 *
 * This allows the SDK runner to be used as a drop-in replacement in the
 * main agent dispatch path without changing the downstream reply pipeline.
 */

import type { ImageContent } from "@mariozechner/pi-ai";
import { execSync } from "node:child_process";
import os from "node:os";
import type { OpenClawConfig } from "../../config/config.js";
import type { AgentRuntimePayload } from "../agent-runtime.js";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { SdkRunnerResult } from "./sdk-runner.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("sdk-runner-adapter");
import { resolveAgentIdFromSessionKey } from "../agent-scope.js";
import { resolveApiKeyForProfile } from "../auth-profiles/oauth.js";
import { ensureAuthProfileStore } from "../auth-profiles/store.js";
import {
  enrichProvidersWithAuthProfiles,
  resolveDefaultSdkProvider,
  type SdkProviderEntry,
} from "./sdk-runner.config.js";
import { runSdkAgent } from "./sdk-runner.js";
import { appendSdkTurnPairToSessionTranscript } from "./sdk-session-transcript.js";

// ---------------------------------------------------------------------------
// Async OAuth token resolution
// ---------------------------------------------------------------------------

/** Mapping of SDK provider keys to auth profile ids for async OAuth. */
const PROVIDER_AUTH_PROFILES: Record<string, string> = {
  zai: "zai:default",
  anthropic: "anthropic:default",
  openrouter: "openrouter:default",
};

/**
 * Try to resolve an API key via async OAuth when sync enrichment didn't
 * produce a key. This handles OAuth token refresh flows that require
 * async operations (e.g., browser-based OAuth).
 */
async function tryAsyncOAuthResolution(
  entry: SdkProviderEntry,
  params: { config?: OpenClawConfig; agentDir?: string },
): Promise<SdkProviderEntry> {
  // Only attempt if we still don't have an auth token.
  if (entry.config.env?.ANTHROPIC_AUTH_TOKEN) {
    return entry;
  }

  // Skip for anthropic provider — OAuth tokens don't work via env var.
  // The anthropic provider should use Claude Code's built-in auth or keychain fallback.
  if (entry.key === "anthropic") {
    return entry;
  }

  const profileId = PROVIDER_AUTH_PROFILES[entry.key];
  if (!profileId) {
    return entry;
  }

  let store;
  try {
    store = ensureAuthProfileStore(params.agentDir);
  } catch {
    return entry;
  }

  try {
    const resolved = await resolveApiKeyForProfile({
      cfg: params.config,
      store,
      profileId,
      agentDir: params.agentDir,
    });
    if (resolved?.apiKey) {
      log.trace(`Resolved API key via async OAuth for ${entry.key}`);
      return {
        ...entry,
        config: {
          ...entry.config,
          env: {
            ...entry.config.env,
            ANTHROPIC_AUTH_TOKEN: resolved.apiKey,
          },
        },
      };
    }
  } catch (err) {
    log.warn(`Async OAuth resolution failed for ${entry.key}: ${String(err)}`);
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Platform credential store fallback for Claude Code OAuth credentials
// ---------------------------------------------------------------------------

/**
 * Try to read Claude Code's OAuth credentials from the platform credential store.
 * This enables subscription billing when running headless (e.g., LaunchAgent on macOS,
 * Windows Service, etc.) where the normal credential access from the Electron app
 * doesn't work.
 *
 * Supports:
 * - macOS: Keychain via `security` command (service: "Claude Code-credentials")
 * - Windows: Credential Manager via PowerShell or file fallback
 * - Linux: File-based credentials (~/.claude/.credentials.json)
 *
 * Only attempts when no auth token is already configured.
 */
function tryPlatformCredentialResolution(entry: SdkProviderEntry): SdkProviderEntry {
  // Only attempt if we still don't have an auth token.
  if (entry.config.env?.ANTHROPIC_AUTH_TOKEN) {
    return entry;
  }
  if (entry.config.env?.ANTHROPIC_API_KEY) {
    return entry;
  }

  // Only for the default anthropic provider (subscription auth).
  if (entry.key !== "anthropic") {
    return entry;
  }

  const platform = os.platform();

  if (platform === "darwin") {
    return tryMacOsKeychainResolution(entry);
  }

  if (platform === "win32") {
    return tryWindowsCredentialResolution(entry);
  }

  if (platform === "linux") {
    return tryFileBasedCredentialResolution(entry);
  }

  return entry;
}

/**
 * Try to read Claude Code's OAuth access token from macOS Keychain.
 * Uses service name "Claude Code-credentials" (the name keytar uses).
 */
function tryMacOsKeychainResolution(entry: SdkProviderEntry): SdkProviderEntry {
  try {
    const username = os.userInfo().username;
    const cmd = `security find-generic-password -s "Claude Code-credentials" -a "${username}" -w 2>/dev/null`;
    const output = execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim();

    if (!output) {
      return entry;
    }

    const parsed = JSON.parse(output);
    const accessToken = parsed?.claudeAiOauth?.accessToken;

    return processAccessToken(entry, accessToken, "macOS Keychain");
  } catch (err) {
    log.trace(`macOS Keychain resolution failed: ${String(err)}`);
  }

  return entry;
}

/**
 * Try to read Claude Code's OAuth access token on Windows.
 *
 * Windows credential resolution attempts:
 * 1. Windows Credential Manager via PowerShell (requires CredentialManager module)
 * 2. File-based fallback (~/.claude/.credentials.json)
 *
 * Note: cmdkey cannot retrieve plaintext passwords by design.
 * The CredentialManager PowerShell module may not be installed on all systems,
 * so we fall back to file-based credentials which Claude Code also supports.
 */
function tryWindowsCredentialResolution(entry: SdkProviderEntry): SdkProviderEntry {
  // First, try Windows Credential Manager via PowerShell.
  // This requires the CredentialManager module: Install-Module -Name CredentialManager
  try {
    // Use .NET CredentialManagement via PowerShell inline (no module required).
    // This uses the same Windows API that keytar uses.
    const psScript = `
Add-Type -AssemblyName System.Runtime.InteropServices
$code = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class CredentialReader {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CredReadW(string target, int type, int reservedFlag, out IntPtr credentialPtr);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CredFree(IntPtr cred);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static string ReadGenericCredential(string target) {
        IntPtr credPtr;
        if (CredReadW(target, 1, 0, out credPtr)) {
            try {
                CREDENTIAL cred = Marshal.PtrToStructure<CREDENTIAL>(credPtr);
                if (cred.CredentialBlob != IntPtr.Zero && cred.CredentialBlobSize > 0) {
                    return Marshal.PtrToStringUni(cred.CredentialBlob, cred.CredentialBlobSize / 2);
                }
            } finally {
                CredFree(credPtr);
            }
        }
        return null;
    }
}
"@
Add-Type -TypeDefinition $code -Language CSharp
$result = [CredentialReader]::ReadGenericCredential("Claude Code-credentials")
if ($result) { Write-Output $result }
`.trim();

    const output = execSync(
      `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, " ")}"`,
      {
        encoding: "utf-8",
        timeout: 10000,
        windowsHide: true,
      },
    ).trim();

    if (output) {
      try {
        const parsed = JSON.parse(output);
        const accessToken = parsed?.claudeAiOauth?.accessToken;
        const result = processAccessToken(entry, accessToken, "Windows Credential Manager");
        if (result !== entry) {
          return result;
        }
      } catch {
        // Output wasn't JSON, try as raw token
        if (output.startsWith("sk-ant-")) {
          const result = processAccessToken(entry, output, "Windows Credential Manager");
          if (result !== entry) {
            return result;
          }
        }
      }
    }
  } catch (err) {
    log.trace(`Windows Credential Manager resolution failed: ${String(err)}`);
  }

  // Fall back to file-based credentials.
  return tryFileBasedCredentialResolution(entry);
}

/**
 * Try to read Claude Code's OAuth access token from the file-based credential store.
 * Claude Code stores credentials at ~/.claude/.credentials.json on Linux
 * and can also use this as a fallback on Windows.
 */
function tryFileBasedCredentialResolution(entry: SdkProviderEntry): SdkProviderEntry {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");

    const homeDir = os.homedir();
    const credPath = path.join(homeDir, ".claude", ".credentials.json");

    if (!fs.existsSync(credPath)) {
      log.trace(`No credentials file at ${credPath}`);
      return entry;
    }

    const content = fs.readFileSync(credPath, "utf-8").trim();
    if (!content) {
      return entry;
    }

    const parsed = JSON.parse(content);
    const accessToken = parsed?.claudeAiOauth?.accessToken;

    return processAccessToken(entry, accessToken, "credentials file");
  } catch (err) {
    log.trace(`File-based credential resolution failed: ${String(err)}`);
  }

  return entry;
}

/**
 * Process an access token and update the provider entry if valid.
 * For OAuth tokens (sk-ant-oat*), we let Claude Code handle auth itself.
 * For API keys, we pass them through as ANTHROPIC_API_KEY.
 */
function processAccessToken(
  entry: SdkProviderEntry,
  accessToken: unknown,
  source: string,
): SdkProviderEntry {
  if (typeof accessToken !== "string" || !accessToken.startsWith("sk-ant-")) {
    return entry;
  }

  // Credentials exist. For OAuth tokens (sk-ant-oat*), we can't pass them
  // as ANTHROPIC_API_KEY because they're not API keys. Instead, don't set any auth
  // env var and let Claude Code access the credential store itself.
  if (accessToken.startsWith("sk-ant-oat")) {
    log.debug(`Found OAuth token in ${source} - letting Claude Code handle auth`);
    return entry;
  }

  // For actual API keys stored in credential store (unlikely but possible), pass them through.
  log.debug(`Resolved API key from ${source}`);
  return {
    ...entry,
    config: {
      ...entry.config,
      env: {
        ...entry.config.env,
        ANTHROPIC_API_KEY: accessToken,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// SDK result → Pi result adapter
// ---------------------------------------------------------------------------

/**
 * Convert an `SdkRunnerResult` into an `EmbeddedPiRunResult` so the
 * downstream reply pipeline can consume it without changes.
 */
function adaptSdkResultToPiResult(params: {
  result: SdkRunnerResult;
  sessionId: string;
}): EmbeddedPiRunResult {
  const result = params.result;
  return {
    payloads: result.payloads.map((p) => ({
      text: p.text,
      isError: p.isError,
    })),
    meta: {
      durationMs: result.meta.durationMs,
      aborted: result.meta.aborted,
      agentMeta: {
        sessionId: params.sessionId,
        provider: result.meta.provider ?? "sdk",
        model: result.meta.model ?? "default",
        // Pass through Claude Code session ID for persistence (used for resume).
        claudeSessionId: result.meta.claudeSessionId,
        // Pass through usage tracking from SDK runner
        usage: result.meta.usage,
      },
      // SDK runner errors are rendered as text payloads with isError=true.
      // Avoid mapping to Pi-specific error kinds (context/compaction) because
      // downstream recovery logic would treat them incorrectly.
      error: undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Main adapter entry point
// ---------------------------------------------------------------------------

export type RunSdkAgentAdaptedParams = {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  config?: OpenClawConfig;
  prompt: string;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  timeoutMs: number;
  runId: string;
  abortSignal?: AbortSignal;
  /** Optional inbound images/audio/video (multimodal input support). */
  images?: ImageContent[];
  /** Claude Code session ID from previous run (for native session resume). */
  claudeSessionId?: string;
  /** Model to use (e.g., "sonnet", "opus", "haiku", or full model ID). */
  model?: string;
  /** Token budget for extended thinking (0 or undefined = disabled). */
  thinkingBudget?: number;
  hooksEnabled?: boolean;
  sdkOptions?: Record<string, unknown>;

  // Tools are lazily built to avoid import cycles.
  tools: AnyAgentTool[];

  // Callbacks with full multimodal support (voice, video, pictures).
  onPartialReply?: (payload: AgentRuntimePayload) => void | Promise<void>;
  onAssistantMessageStart?: () => void | Promise<void>;
  onBlockReply?: (payload: AgentRuntimePayload) => void | Promise<void>;
  onToolResult?: (payload: AgentRuntimePayload) => void | Promise<void>;
  onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void | Promise<void>;
};

/**
 * Run the SDK agent and return a Pi-compatible result.
 *
 * This is the function called from `agent-runner-execution.ts` when the
 * SDK runtime is selected.
 */
export async function runSdkAgentAdapted(
  params: RunSdkAgentAdaptedParams,
): Promise<EmbeddedPiRunResult> {
  // Resolve the SDK provider from config + auth profiles.
  let authStore;
  try {
    authStore = ensureAuthProfileStore(params.agentDir);
  } catch {
    log.trace("Could not load auth profile store");
  }

  // Resolve agent ID from session key to select the appropriate CCSDK provider.
  const agentId = params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined;

  let providerEntry = resolveDefaultSdkProvider({
    config: params.config,
    agentId,
  });

  // Enrich with auth profile keys.
  if (providerEntry && authStore) {
    const enriched = enrichProvidersWithAuthProfiles({
      providers: [providerEntry],
      store: authStore,
    });
    providerEntry = enriched[0] ?? providerEntry;
  }

  // Fall back to async OAuth resolution if sync enrichment didn't produce a key.
  if (providerEntry && !providerEntry.config.env?.ANTHROPIC_AUTH_TOKEN) {
    providerEntry = await tryAsyncOAuthResolution(providerEntry, {
      config: params.config,
      agentDir: params.agentDir,
    });
  }

  // Fall back to platform credential store for Claude Code subscription auth.
  // This validates credentials exist and lets Claude Code use its own credential access.
  if (providerEntry && !providerEntry.config.env?.ANTHROPIC_AUTH_TOKEN) {
    providerEntry = tryPlatformCredentialResolution(providerEntry);
  } else if (!providerEntry) {
    // Create a default anthropic provider entry for credential resolution
    const defaultEntry: SdkProviderEntry = {
      key: "anthropic",
      config: { name: "Anthropic (Claude Code)" },
    };
    providerEntry = tryPlatformCredentialResolution(defaultEntry);
  }

  log.debug(
    `Running SDK agent` +
      (providerEntry ? ` with provider "${providerEntry.config.name}"` : " (default provider)"),
  );

  const sdkResult = await runSdkAgent({
    runId: params.runId,
    sessionId: params.sessionId,
    prompt: params.prompt,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    config: params.config,
    tools: params.tools,
    provider: providerEntry?.config,
    systemPrompt: params.extraSystemPrompt,
    model: params.model,
    thinkingBudget: params.thinkingBudget,
    timeoutMs: params.timeoutMs,
    abortSignal: params.abortSignal,
    claudeSessionId: params.claudeSessionId,
    hooksEnabled: params.hooksEnabled,
    sdkOptions: params.sdkOptions,
    onPartialReply: params.onPartialReply,
    onAssistantMessageStart: params.onAssistantMessageStart,
    onBlockReply: params.onBlockReply,
    onToolResult: params.onToolResult,
    onAgentEvent: params.onAgentEvent,
  });

  // Persist a minimal user/assistant turn pair so SDK main-agent mode has multi-turn continuity.
  // This intentionally records only text, not tool call structures.
  appendSdkTurnPairToSessionTranscript({
    sessionFile: params.sessionFile,
    prompt: params.prompt,
    assistantText: sdkResult.payloads.find(
      (p) => !p.isError && typeof p.text === "string" && p.text.trim(),
    )?.text,
  });

  return adaptSdkResultToPiResult({ result: sdkResult, sessionId: params.sessionId });
}
