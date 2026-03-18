/**
 * OpenViking Session Bridge
 *
 * Flushes OpenClaw session transcripts into OpenViking at session boundaries.
 *
 * Trigger: `session_end` hook (fire-and-forget, incremental, idempotent).
 * Command:  `/done`  — synchronous flush; user still needs to send `/new` to
 *            rotate the session (see INSTALL.md for auto-reset config tip).
 *
 * Enabled: false by default — set `enabled: true` in plugin config to activate.
 *
 * Deviation from PRD:
 *   - Located under extensions/ (repo-native) rather than the non-existent plugins/.
 *   - /done flushes synchronously but does NOT auto-reset the session.
 *     To get reset-on-done, add "/done" to session.resetTriggers in clawdbot.json.
 */

import { homedir } from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { parseOVSessionBridgeConfig } from "./src/config.js";
import { flushSessionToOV, flushWithTimeout } from "./src/flush.js";
import { loadCheckpoint } from "./src/state.js";
import type { SessionCheckpoint } from "./src/types.js";

// Module-level tracking map: sessionId → metadata needed for flush.
// Populated via session_start; used by session_end and /done.
type TrackedSession = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  sessionFile?: string;
};

const activeSessions = new Map<string, TrackedSession>();

const sessionBridgePlugin = {
  id: "openviking-session-bridge",
  name: "OpenViking Session Bridge",
  description: "Flush session transcripts to OpenViking at session boundaries",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const cfg = parseOVSessionBridgeConfig(api.pluginConfig ?? {});

    if (!cfg.enabled) {
      api.logger.info("openviking-session-bridge: disabled (set enabled:true to activate)");
      // Still register hooks as no-ops so the plugin loads cleanly.
    }

    // -------------------------------------------------------------------------
    // session_start: track active sessions for later flush resolution
    // -------------------------------------------------------------------------
    api.on("session_start", (event, ctx) => {
      if (!event.sessionId) return;
      const sessionKey = ctx?.sessionKey ?? event.sessionKey ?? "";
      const agentId = ctx?.agentId ?? "main";
      activeSessions.set(event.sessionId, {
        sessionId: event.sessionId,
        sessionKey,
        agentId,
      });
      api.logger.debug?.(
        `openviking-session-bridge: tracking session ${event.sessionId} (key=${sessionKey})`,
      );
    });

    // -------------------------------------------------------------------------
    // session_end: fire-and-forget incremental flush
    // -------------------------------------------------------------------------
    api.on("session_end", (event, ctx) => {
      if (!cfg.enabled) return;
      if (!event.sessionId) return;

      const sessionId = event.sessionId;
      const sessionKey = ctx?.sessionKey ?? event.sessionKey ?? "";
      const agentId = ctx?.agentId ?? "main";

      // Resolve sessionFile: try tracked entry first, then fall back to
      // standard path resolution via OpenClaw state dir.
      const tracked = activeSessions.get(sessionId);
      const sessionFile = tracked?.sessionFile ?? resolveSessionFile(sessionId, agentId, api);

      api.logger.debug?.(
        `openviking-session-bridge: session_end for ${sessionId} (file=${sessionFile ?? "?"})`,
      );

      // Fire-and-forget: the main event loop must not block here.
      void (async () => {
        try {
          const result = await flushSessionToOV({
            openclawSessionId: sessionId,
            sessionKey,
            agentId,
            sessionFile,
            cfg,
            isFinalFlush: true,
          });

          if (result.skipped) {
            api.logger.debug?.(
              `openviking-session-bridge: session ${sessionId} flush skipped (finalized=${result.finalized})`,
            );
          } else if (result.ok) {
            api.logger.info(
              `openviking-session-bridge: flushed ${result.turnsFlushed} turns for session ${sessionId}` +
                (result.finalized ? " (committed)" : ""),
            );
          } else {
            api.logger.warn(
              `openviking-session-bridge: flush failed for session ${sessionId}: ${result.error}`,
            );
          }
        } catch (err) {
          api.logger.warn(
            `openviking-session-bridge: unexpected error during flush: ${String(err)}`,
          );
        } finally {
          activeSessions.delete(sessionId);
        }
      })();
    });

    // -------------------------------------------------------------------------
    // /done command: synchronous flush with timeout
    //
    // Flushes ALL non-finalized tracked sessions (typically just one).
    // Returns confirmation reply; user should send /new to start a fresh session.
    //
    // To auto-reset on /done, add "/done" to session.resetTriggers in
    // clawdbot.json and the plugin will still flush synchronously.
    // -------------------------------------------------------------------------
    api.registerCommand({
      name: "done",
      description:
        "Flush current session to OpenViking synchronously, then confirm. " +
        "Follow with /new to start a fresh session.",
      handler: async () => {
        if (!cfg.enabled) {
          return {
            text: "openviking-session-bridge is disabled. Set enabled:true in plugin config to activate.",
          };
        }

        // Collect all non-finalized sessions to flush.
        const toFlush: TrackedSession[] = [];
        for (const session of activeSessions.values()) {
          const cp: SessionCheckpoint | null = loadCheckpoint(cfg.stateDir, session.sessionId);
          if (!cp?.finalized) {
            const sessionFile =
              session.sessionFile ?? resolveSessionFile(session.sessionId, session.agentId, api);
            toFlush.push({ ...session, sessionFile });
          }
        }

        if (toFlush.length === 0) {
          return { text: "✅ No active sessions to flush. Use /new to start fresh." };
        }

        const results = await Promise.all(
          toFlush.map((s) =>
            flushWithTimeout(
              {
                openclawSessionId: s.sessionId,
                sessionKey: s.sessionKey,
                agentId: s.agentId,
                sessionFile: s.sessionFile,
                cfg,
                isFinalFlush: true,
              },
              cfg.flushTimeoutMs,
            ),
          ),
        );

        const succeeded = results.filter((r) => r.ok && !r.skipped);
        const failed = results.filter((r) => !r.ok);
        const skipped = results.filter((r) => r.skipped);

        if (failed.length > 0) {
          const errors = failed.map((r) => r.error ?? "unknown").join("; ");
          api.logger.warn(`openviking-session-bridge: /done flush failed: ${errors}`);
          return {
            text:
              `⚠️ Session flush partially failed (${failed.length}/${toFlush.length}). ` +
              `Check logs. Errors: ${errors}`,
          };
        }

        const totalTurns = succeeded.reduce((sum, r) => sum + r.turnsFlushed, 0);
        const note = skipped.length > 0 ? ` (${skipped.length} already finalized)` : "";

        return {
          text:
            `✅ Session saved to OpenViking (${totalTurns} turn${totalTurns === 1 ? "" : "s"} flushed${note}). ` +
            `Use /new to start a fresh session.`,
        };
      },
    });

    api.logger.info(
      `openviking-session-bridge: registered (enabled=${cfg.enabled}, baseUrl=${cfg.baseUrl})`,
    );
  },
};

/**
 * Best-effort resolution of the session transcript file path.
 * Mirrors the standard OpenClaw state directory structure:
 *   ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
 *
 * Respects OPENCLAW_STATE_DIR env var if set (same as OpenClaw core).
 */
function resolveSessionFile(
  sessionId: string,
  agentId: string,
  _api: OpenClawPluginApi,
): string | undefined {
  try {
    const stateDir =
      process.env.OPENCLAW_STATE_DIR ??
      `${process.env.HOME ?? process.env.USERPROFILE ?? homedir()}/.openclaw`;
    return `${stateDir}/agents/${agentId}/sessions/${sessionId}.jsonl`;
  } catch {
    return undefined;
  }
}

export default sessionBridgePlugin;
