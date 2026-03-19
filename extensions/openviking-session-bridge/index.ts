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
import { buildOVPluginConfigSchema, parseOVSessionBridgeConfig } from "./src/config.js";
import { enqueueFlush, flushWithTimeout } from "./src/flush.js";
import { listPendingCheckpoints, loadCheckpoint } from "./src/state.js";
import type { SessionCheckpoint } from "./src/types.js";

// ── Constants ─────────────────────────────────────────────────────────────────

// Maximum number of sessions tracked in activeSessions before we start
// evicting the oldest entries (guards against unbounded growth in long-lived
// processes with many short sessions that never fire session_end).
const MAX_TRACKED_SESSIONS = 500;

// Sessions older than this TTL are eligible for eviction from activeSessions
// even if session_end was never fired (e.g. process restart, crash).
const SESSION_TRACKING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Maximum attempts for the session_end fire-and-forget flush before giving up.
const SESSION_END_MAX_RETRIES = 3;

// Base delay between session_end retry attempts (multiplied by attempt index).
const SESSION_END_RETRY_BASE_DELAY_MS = 2_000;

// ── Module-level session tracking ────────────────────────────────────────────

type TrackedSession = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  sessionFile?: string;
  /** Epoch ms when this session was first tracked (for TTL eviction). */
  trackedAt: number;
};

const activeSessions = new Map<string, TrackedSession>();

/**
 * Evict stale entries from activeSessions.
 *
 * Runs on every session_start.  Removes entries older than SESSION_TRACKING_TTL_MS
 * first, then trims by age if the map still exceeds MAX_TRACKED_SESSIONS.
 * O(n) per call but n is bounded by MAX_TRACKED_SESSIONS so cost is small.
 */
function pruneActiveSessions(): void {
  const now = Date.now();

  // Remove TTL-expired entries.
  for (const [id, s] of activeSessions.entries()) {
    if (now - s.trackedAt > SESSION_TRACKING_TTL_MS) {
      activeSessions.delete(id);
    }
  }

  // If still over the cap, evict oldest first.
  if (activeSessions.size > MAX_TRACKED_SESSIONS) {
    const sorted = [...activeSessions.entries()].sort(([, a], [, b]) => a.trackedAt - b.trackedAt);
    const excess = activeSessions.size - MAX_TRACKED_SESSIONS;
    for (let i = 0; i < excess; i++) {
      if (sorted[i]) activeSessions.delete(sorted[i][0]);
    }
  }
}

// ── Plugin definition ─────────────────────────────────────────────────────────

const sessionBridgePlugin = {
  id: "openviking-session-bridge",
  name: "OpenViking Session Bridge",
  description: "Flush session transcripts to OpenViking at session boundaries",
  // Matches the configSchema declared in openclaw.plugin.json; provides
  // runtime validation and UI hints (replaces the previous emptyPluginConfigSchema()
  // which rejected any non-empty config object).
  configSchema: buildOVPluginConfigSchema(),

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

      // Evict stale entries before adding new ones.
      pruneActiveSessions();

      activeSessions.set(event.sessionId, {
        sessionId: event.sessionId,
        sessionKey,
        agentId,
        trackedAt: Date.now(),
      });
      api.logger.debug?.(
        `openviking-session-bridge: tracking session ${event.sessionId} (key=${sessionKey})`,
      );
    });

    // -------------------------------------------------------------------------
    // session_end: fire-and-forget incremental flush with retry
    //
    // Uses enqueueFlush() to prevent concurrent flushes for the same session
    // (e.g. if /done fires simultaneously).  Retries on transient failures with
    // exponential back-off before giving up.
    // -------------------------------------------------------------------------
    api.on("session_end", (event, ctx) => {
      if (!cfg.enabled) return;
      if (!event.sessionId) return;

      const sessionId = event.sessionId;
      const sessionKey = ctx?.sessionKey ?? event.sessionKey ?? "";
      const agentId = ctx?.agentId ?? "main";

      const tracked = activeSessions.get(sessionId);
      const sessionFile = tracked?.sessionFile ?? resolveSessionFile(sessionId, agentId, api);

      api.logger.debug?.(
        `openviking-session-bridge: session_end for ${sessionId} (file=${sessionFile ?? "?"})`,
      );

      const flushParams = {
        openclawSessionId: sessionId,
        sessionKey,
        agentId,
        sessionFile,
        cfg,
        isFinalFlush: true,
      };

      // Fire-and-forget with retry: the main event loop must not block here.
      void (async () => {
        let lastResult: {
          ok: boolean;
          skipped?: boolean;
          turnsFlushed?: number;
          finalized?: boolean;
          error?: string;
        } | null = null;

        for (let attempt = 0; attempt < SESSION_END_MAX_RETRIES; attempt++) {
          try {
            lastResult = await enqueueFlush(flushParams);
            if (lastResult.ok || lastResult.skipped) break; // success or idempotent skip
          } catch (err) {
            lastResult = { ok: false, error: String(err) };
          }
          if (attempt < SESSION_END_MAX_RETRIES - 1) {
            const delay = SESSION_END_RETRY_BASE_DELAY_MS * (attempt + 1);
            api.logger.debug?.(
              `openviking-session-bridge: session_end retry ${attempt + 1}/${SESSION_END_MAX_RETRIES - 1} ` +
                `in ${delay}ms for session ${sessionId}: ${lastResult?.error ?? "unknown error"}`,
            );
            await new Promise<void>((r) => setTimeout(r, delay));
          }
        }

        if (lastResult?.skipped) {
          api.logger.debug?.(
            `openviking-session-bridge: session ${sessionId} flush skipped (finalized=${lastResult.finalized})`,
          );
        } else if (lastResult?.ok) {
          api.logger.info(
            `openviking-session-bridge: flushed ${lastResult.turnsFlushed ?? 0} turns for session ${sessionId}` +
              (lastResult.finalized ? " (committed)" : ""),
          );
        } else {
          api.logger.warn(
            `openviking-session-bridge: flush failed for session ${sessionId} after ${SESSION_END_MAX_RETRIES} attempts: ${lastResult?.error ?? "unknown"}`,
          );
        }

        activeSessions.delete(sessionId);
      })();
    });

    // -------------------------------------------------------------------------
    // /done command: synchronous flush with timeout
    //
    // Flushes ALL non-finalized tracked sessions (typically just one).
    // Returns confirmation reply; user should send /new to start a fresh session.
    //
    // Uses flushWithTimeout (which internally uses enqueueFlush) so concurrent
    // session_end flushes are coalesced rather than doubled.
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

    // -------------------------------------------------------------------------
    // Startup replay: re-flush sessions from previous process runs that were
    // interrupted before session_end completed (e.g. process killed mid-flush).
    //
    // We scan stateDir for non-finalized checkpoints not currently in
    // activeSessions (those are still live and will flush via session_end).
    // Per-turn checkpointing ensures replayed flushes resume from the correct
    // offset without resending already-delivered turns.
    // -------------------------------------------------------------------------
    if (cfg.enabled) {
      void (async () => {
        const pending = listPendingCheckpoints(cfg.stateDir);
        if (pending.length === 0) return;

        api.logger.info(
          `openviking-session-bridge: startup replay — ${pending.length} non-finalized checkpoint(s) found`,
        );

        for (const cp of pending) {
          // Skip sessions still actively tracked (session_end will handle them).
          if (activeSessions.has(cp.openclawSessionId)) continue;

          const sessionFile = resolveSessionFile(cp.openclawSessionId, cp.agentId, api);
          api.logger.debug?.(
            `openviking-session-bridge: startup replay for session ${cp.openclawSessionId}`,
          );

          void enqueueFlush({
            openclawSessionId: cp.openclawSessionId,
            sessionKey: cp.sessionKey,
            agentId: cp.agentId,
            sessionFile,
            cfg,
            isFinalFlush: true,
          }).then((result) => {
            if (result.ok && !result.skipped) {
              api.logger.info(
                `openviking-session-bridge: startup-replay flushed ${result.turnsFlushed} turn(s) for ${cp.openclawSessionId}`,
              );
            } else if (!result.ok) {
              api.logger.warn(
                `openviking-session-bridge: startup-replay flush failed for ${cp.openclawSessionId}: ${result.error}`,
              );
            }
          });
        }
      })();
    }
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
