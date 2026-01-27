/**
 * Anchorbrowser session management for sandbox browser contexts.
 *
 * Manages the lifecycle of Anchorbrowser sessions:
 * - Creates sessions on-demand when the browser tool is first used
 * - Tracks active sessions for reuse within the same scope
 * - Cleans up sessions when the agent session ends
 */

import type { BrowserBridge } from "../../browser/bridge-server.js";
import { startBrowserBridgeServer, stopBrowserBridgeServer } from "../../browser/bridge-server.js";
import type { ResolvedBrowserConfig } from "../../browser/config.js";
import {
  DEFAULT_BROWSER_EVALUATE_ENABLED,
  DEFAULT_CLAWD_BROWSER_COLOR,
} from "../../browser/constants.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  createAnchorBrowserSession,
  endAnchorBrowserSession,
  type AnchorBrowserSession,
} from "./anchorbrowser.js";
import type { SandboxBrowserConfig, SandboxBrowserContext } from "./types.js";

const log = createSubsystemLogger("sandbox").child("anchorbrowser");

// ---------------------------------------------------------------------------
// Session tracking
// ---------------------------------------------------------------------------

type AnchorSessionEntry = {
  session: AnchorBrowserSession;
  bridge: BrowserBridge;
  apiKey: string;
  apiUrl?: string;
};

/** Map of scopeKey -> active Anchorbrowser session entry. */
const ANCHOR_SESSIONS = new Map<string, AnchorSessionEntry>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the Anchorbrowser API key from config or environment.
 */
function resolveAnchorApiKey(browserCfg: SandboxBrowserConfig): string {
  const apiKey =
    browserCfg.anchorbrowser?.apiKey?.trim() || process.env.ANCHORBROWSER_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "Anchorbrowser API key not configured. " +
        "Set agents.defaults.sandbox.browser.anchorbrowser.apiKey in config " +
        "or ANCHORBROWSER_API_KEY environment variable.",
    );
  }

  return apiKey;
}

/**
 * Build a ResolvedBrowserConfig for a remote CDP endpoint.
 */
function buildRemoteBrowserConfig(params: {
  cdpUrl: string;
  evaluateEnabled: boolean;
}): ResolvedBrowserConfig {
  const parsed = new URL(params.cdpUrl);
  const cdpHost = parsed.hostname;
  const cdpProtocol = parsed.protocol === "https:" ? "https" : "http";
  const isLoopback =
    cdpHost === "localhost" ||
    cdpHost === "127.0.0.1" ||
    cdpHost === "0.0.0.0" ||
    cdpHost === "::1";

  return {
    enabled: true,
    evaluateEnabled: params.evaluateEnabled,
    controlPort: 0, // Will be assigned by the bridge server
    cdpProtocol,
    cdpHost,
    cdpIsLoopback: isLoopback,
    remoteCdpTimeoutMs: 5000, // Longer timeout for remote
    remoteCdpHandshakeTimeoutMs: 10000,
    color: DEFAULT_CLAWD_BROWSER_COLOR,
    executablePath: undefined,
    headless: false, // Anchorbrowser manages this
    noSandbox: false,
    attachOnly: true, // Never launch locally
    defaultProfile: "remote",
    profiles: {
      remote: {
        cdpUrl: params.cdpUrl,
        color: DEFAULT_CLAWD_BROWSER_COLOR,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure an Anchorbrowser session exists for the given scope.
 *
 * If a session already exists for this scope, reuses it.
 * Otherwise, creates a new session via the Anchorbrowser API.
 */
export async function ensureAnchorBrowser(params: {
  scopeKey: string;
  cfg: SandboxBrowserConfig;
  evaluateEnabled?: boolean;
}): Promise<SandboxBrowserContext | null> {
  // Check for existing session
  const existing = ANCHOR_SESSIONS.get(params.scopeKey);
  if (existing) {
    log.debug(`Reusing existing Anchorbrowser session for scope ${params.scopeKey}`);
    return {
      bridgeUrl: existing.bridge.baseUrl,
      liveViewUrl: existing.session.liveViewUrl,
      sessionId: existing.session.id,
    };
  }

  // Resolve API key
  const apiKey = resolveAnchorApiKey(params.cfg);
  const apiUrl = params.cfg.anchorbrowser?.apiUrl;

  log.info(`Creating new Anchorbrowser session for scope ${params.scopeKey}`);

  // Create new session via API
  const session = await createAnchorBrowserSession({
    apiKey,
    apiUrl,
    headless: params.cfg.anchorbrowser?.headless ?? params.cfg.headless,
    viewport: params.cfg.anchorbrowser?.viewport,
    proxy: params.cfg.anchorbrowser?.proxy,
    captchaSolver: params.cfg.anchorbrowser?.captchaSolver,
    adblock: params.cfg.anchorbrowser?.adblock,
    popupBlocker: params.cfg.anchorbrowser?.popupBlocker,
    timeout: params.cfg.anchorbrowser?.timeout,
    recording: params.cfg.anchorbrowser?.recording,
    extraStealth: params.cfg.anchorbrowser?.extraStealth,
  });

  log.info(`Anchorbrowser session created: ${session.id}`);
  if (session.liveViewUrl) {
    log.info(`Live view URL: ${session.liveViewUrl}`);
  }

  // Start local bridge server pointing at the remote CDP
  const evaluateEnabled = params.evaluateEnabled ?? DEFAULT_BROWSER_EVALUATE_ENABLED;
  const bridge = await startBrowserBridgeServer({
    resolved: buildRemoteBrowserConfig({
      cdpUrl: session.cdpUrl,
      evaluateEnabled,
    }),
  });

  // Track the session
  ANCHOR_SESSIONS.set(params.scopeKey, {
    session,
    bridge,
    apiKey,
    apiUrl,
  });

  return {
    bridgeUrl: bridge.baseUrl,
    liveViewUrl: session.liveViewUrl,
    sessionId: session.id,
  };
}

/**
 * Clean up an Anchorbrowser session for the given scope.
 *
 * Stops the local bridge server and ends the remote session via API.
 */
export async function cleanupAnchorBrowserSession(scopeKey: string): Promise<void> {
  const entry = ANCHOR_SESSIONS.get(scopeKey);
  if (!entry) return;

  log.info(`Cleaning up Anchorbrowser session for scope ${scopeKey}`);

  // Stop the local bridge server
  try {
    await stopBrowserBridgeServer(entry.bridge.server);
  } catch (err) {
    log.warn(`Failed to stop bridge server: ${err instanceof Error ? err.message : String(err)}`);
  }

  // End the remote session
  try {
    await endAnchorBrowserSession({
      apiKey: entry.apiKey,
      apiUrl: entry.apiUrl,
      sessionId: entry.session.id,
    });
    log.info(`Anchorbrowser session ${entry.session.id} ended`);
  } catch (err) {
    log.warn(
      `Failed to end Anchorbrowser session: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  ANCHOR_SESSIONS.delete(scopeKey);
}

/**
 * Clean up all active Anchorbrowser sessions.
 *
 * Called during gateway shutdown.
 */
export async function cleanupAllAnchorBrowserSessions(): Promise<void> {
  const scopeKeys = Array.from(ANCHOR_SESSIONS.keys());
  for (const scopeKey of scopeKeys) {
    await cleanupAnchorBrowserSession(scopeKey);
  }
}

/**
 * Check if an Anchorbrowser session exists for the given scope.
 */
export function hasAnchorBrowserSession(scopeKey: string): boolean {
  return ANCHOR_SESSIONS.has(scopeKey);
}

/**
 * Get the Anchorbrowser session entry for a scope (if any).
 */
export function getAnchorBrowserSessionEntry(scopeKey: string): AnchorSessionEntry | undefined {
  return ANCHOR_SESSIONS.get(scopeKey);
}
