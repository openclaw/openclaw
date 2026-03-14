/**
 * spawn-interceptor v2.5.2 — OpenClaw plugin for automatic ACP task tracking.
 *
 * Completion detection (layered, in priority order):
 *   1. subagent_ended hook — works for runtime=subagent only
 *   2. ACP session poller — reads ~/.acpx/sessions/index.json for closed sessions
 *   3. Stale reaper — marks tasks stuck > 30min as timeout (final safety net)
 *
 * Key insight: OpenClaw's subagent_ended hook does NOT fire for ACP runtime sessions.
 * ACP sessions are managed by acpx, and their lifecycle is recorded in ~/.acpx/sessions/.
 * The poller reads the index.json to find closed sessions, then matches them to pending
 * tasks by creation time proximity.
 *
 * v2.5 fixes (review feedback):
 *   - subagent_ended now matches by targetSessionKey instead of first-match-by-type
 *   - ACP poller consumes matched closed sessions to prevent double-matching
 *   - Fallback "no open sessions" status changed from completed to assumed_complete
 *   - Added unregister() for proper timer cleanup on plugin hot-reload
 *   - Version synced between package.json and index.js
 *
 * v2.5.1 fixes:
 *   - consumedAcpSessionIds persisted across poll iterations (previously recreated each tick)
 *
 * v2.5.2 fixes:
 *   - ACP matcher requires session creation time >= spawn time (minus 2s clock skew tolerance)
 *     to prevent pre-existing closed sessions from matching newly spawned tasks
 */

import fs from "fs";
import os from "os";
import path from "path";

const SHARED_CTX = path.join(os.homedir(), ".openclaw", "shared-context");
const TASK_LOG = path.join(SHARED_CTX, "monitor-tasks", "task-log.jsonl");
const PENDING_FILE = path.join(SHARED_CTX, "monitor-tasks", ".pending-tasks.json");
const ACPX_SESSIONS_DIR = path.join(os.homedir(), ".acpx", "sessions");
const ACPX_INDEX = path.join(ACPX_SESSIONS_DIR, "index.json");
const COMPLETION_SESSION = "agent:main:completion-relay";

const STALE_TIMEOUT_MS = 30 * 60 * 1000;
const REAPER_INTERVAL_MS = 5 * 60 * 1000;
const ACP_POLL_INTERVAL_MS = 15 * 1000;

let pendingTasks = new Map();
let reaperTimer = null;
let acpPollerTimer = null;
let pluginLogger = null;
let consumedAcpSessionIds = new Set();

function loadPending() {
  try {
    if (fs.existsSync(PENDING_FILE)) {
      const data = JSON.parse(fs.readFileSync(PENDING_FILE, "utf-8"));
      pendingTasks = new Map(Object.entries(data));
    }
  } catch {
    /* start fresh */
  }
}

function savePending() {
  try {
    const dir = path.dirname(PENDING_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmp = PENDING_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(pendingTasks), null, 2));
    fs.renameSync(tmp, PENDING_FILE);
  } catch {
    /* non-fatal */
  }
}

function genId() {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const r = Math.random().toString(36).slice(2, 8);
  return `tsk_${ts}_${r}`;
}

function appendLog(entry) {
  const dir = path.dirname(TASK_LOG);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(TASK_LOG, JSON.stringify(entry) + "\n");
}

function relay(taskId) {
  return `\n\n---\n[COMPLETION RELAY — OPTIONAL]\nWhen done, call sessions_send with:\n  sessionKey: "${COMPLETION_SESSION}"\n  message: {"type":"acp_completion","taskId":"${taskId}","status":"completed or failed","summary":"one-sentence result"}\nThis is optional — completion is tracked automatically.\n---`;
}

function reapStaleTasks() {
  const now = Date.now();
  let reaped = 0;

  for (const [taskId, task] of pendingTasks.entries()) {
    const spawnedAt = new Date(task.spawnedAt).getTime();
    if (now - spawnedAt > STALE_TIMEOUT_MS) {
      pendingTasks.delete(taskId);
      appendLog({
        taskId,
        agentId: task.agentId,
        sessionKey: task.sessionKey,
        runtime: task.runtime,
        task: task.task,
        spawnedAt: task.spawnedAt,
        status: "timeout",
        completedAt: new Date().toISOString(),
        completionSource: "stale_reaper",
        reason: `no completion detected within ${STALE_TIMEOUT_MS / 60000}min`,
      });
      reaped++;
    }
  }

  if (reaped > 0) {
    savePending();
    if (pluginLogger) {
      pluginLogger.info(
        `spawn-interceptor: reaped ${reaped} stale task(s), ${pendingTasks.size} still pending`,
      );
    }
  }
}

function pollAcpSessions() {
  const acpPending = [...pendingTasks.entries()].filter(([, t]) => t.runtime === "acp");
  if (acpPending.length === 0) {
    return;
  }

  let index;
  try {
    if (!fs.existsSync(ACPX_INDEX)) {
      return;
    }
    index = JSON.parse(fs.readFileSync(ACPX_INDEX, "utf-8"));
  } catch {
    return;
  }

  const entries = index.entries || [];
  if (entries.length === 0) {
    return;
  }

  const TIME_MATCH_WINDOW_MS = 60 * 1000;
  const BATCH_CLEANUP_AGE_MS = 2 * 60 * 1000;
  let completed = 0;

  const closedSessions = [];
  const openSessions = [];

  for (const entry of entries) {
    if (entry.closed) {
      closedSessions.push(entry);
    } else {
      openSessions.push(entry);
    }
  }

  for (const [taskId, task] of acpPending) {
    const spawnTs = new Date(task.spawnedAt).getTime();

    let matched = false;
    for (const session of closedSessions) {
      if (consumedAcpSessionIds.has(session.acpxRecordId)) {
        continue;
      }

      let sessionDetail = null;
      try {
        const fp = path.join(ACPX_SESSIONS_DIR, session.file);
        if (fs.existsSync(fp)) {
          sessionDetail = JSON.parse(fs.readFileSync(fp, "utf-8"));
        }
      } catch {
        /* skip */
      }

      const sessionCreatedAt = sessionDetail
        ? new Date(sessionDetail.created_at).getTime()
        : new Date(session.lastUsedAt).getTime();

      const timeDiff = sessionCreatedAt - spawnTs;

      if (timeDiff >= -2000 && timeDiff < TIME_MATCH_WINDOW_MS) {
        const closedAt = sessionDetail?.closed_at || session.lastUsedAt || new Date().toISOString();
        const sessionName = sessionDetail?.name || session.name || "?";

        pendingTasks.delete(taskId);
        consumedAcpSessionIds.add(session.acpxRecordId);
        appendLog({
          taskId,
          agentId: task.agentId,
          sessionKey: task.sessionKey,
          runtime: task.runtime,
          task: task.task,
          spawnedAt: task.spawnedAt,
          status: "completed",
          completedAt: closedAt,
          completionSource: "acp_session_poller",
          acpxSession: session.acpxRecordId,
          acpxSessionName: sessionName,
          reason: `acpx session closed (time match: ${Math.round(timeDiff / 1000)}s)`,
        });

        matched = true;
        completed++;

        if (pluginLogger) {
          pluginLogger.info(
            `spawn-interceptor: ACP task ${taskId} → completed (acpx session ${session.acpxRecordId} closed, match=${Math.round(timeDiff / 1000)}s)`,
          );
        }
        break;
      }
    }

    if (!matched) {
      const age = Date.now() - spawnTs;
      if (age > BATCH_CLEANUP_AGE_MS && openSessions.length === 0) {
        pendingTasks.delete(taskId);
        appendLog({
          taskId,
          agentId: task.agentId,
          sessionKey: task.sessionKey,
          runtime: task.runtime,
          task: task.task,
          spawnedAt: task.spawnedAt,
          status: "assumed_complete",
          completedAt: new Date().toISOString(),
          completionSource: "acp_session_poller",
          reason: `no open ACP sessions remain (task age: ${Math.round(age / 1000)}s, heuristic — actual outcome unknown)`,
        });

        completed++;

        if (pluginLogger) {
          pluginLogger.info(
            `spawn-interceptor: ACP task ${taskId} → assumed_complete (no open ACP sessions, age=${Math.round(age / 1000)}s)`,
          );
        }
      }
    }
  }

  if (completed > 0) {
    savePending();
    if (pluginLogger) {
      pluginLogger.info(
        `spawn-interceptor: ACP poller completed ${completed} task(s), ${pendingTasks.size} still pending`,
      );
    }
  }
}

const spawnInterceptorPlugin = {
  id: "spawn-interceptor",
  name: "Spawn Interceptor",
  description: "Auto-tracks sessions_spawn and detects ACP completion via session polling",
  version: "2.5.2",

  register(api) {
    pluginLogger = api.logger;
    api.logger.info(
      "spawn-interceptor v2.5.2: registering (subagent_ended + ACP session poller + stale reaper)",
    );

    loadPending();
    if (pendingTasks.size > 0) {
      api.logger.info(`spawn-interceptor: restored ${pendingTasks.size} pending task(s) from disk`);
      reapStaleTasks();
      pollAcpSessions();
    }

    // Clear any pre-existing timers from a previous register() call (hot-reload)
    if (reaperTimer) {
      clearInterval(reaperTimer);
      reaperTimer = null;
    }
    if (acpPollerTimer) {
      clearInterval(acpPollerTimer);
      acpPollerTimer = null;
    }

    reaperTimer = setInterval(reapStaleTasks, REAPER_INTERVAL_MS);
    acpPollerTimer = setInterval(pollAcpSessions, ACP_POLL_INTERVAL_MS);

    api.on("before_tool_call", (event, ctx) => {
      if (event.toolName !== "sessions_spawn") {
        return;
      }

      const p = event.params || {};
      const id = genId();
      const rt = p.runtime || "subagent";

      const taskEntry = {
        taskId: id,
        agentId: ctx.agentId || "?",
        sessionKey: ctx.sessionKey || "",
        runtime: rt,
        task: String(p.task || "").slice(0, 200),
        spawnedAt: new Date().toISOString(),
        status: "spawning",
      };

      appendLog(taskEntry);
      pendingTasks.set(id, taskEntry);
      savePending();

      api.logger.info(
        `spawn-interceptor: tracked ${id} (runtime=${rt}, pending=${pendingTasks.size})`,
      );

      if (rt === "acp" && p.task) {
        return { params: { ...p, task: p.task + relay(id) } };
      }
    });

    api.on("subagent_ended", (event, ctx) => {
      const targetKey = event.targetSessionKey || "";
      const reason = event.reason || "";
      const outcome = event.outcome || "";
      const endedAt = new Date().toISOString();

      let matchedTaskId = null;
      let matchedTask = null;

      // Match by targetSessionKey for precise identification.
      // Falls back to first subagent task only when no session key is available.
      for (const [taskId, task] of pendingTasks.entries()) {
        if (task.runtime !== "subagent") {
          continue;
        }
        if (targetKey && task.spawnedSessionKey === targetKey) {
          matchedTaskId = taskId;
          matchedTask = task;
          break;
        }
      }

      // Fallback: if no precise match and only one subagent pending, use it
      if (!matchedTaskId) {
        const subagentTasks = [...pendingTasks.entries()].filter(
          ([, t]) => t.runtime === "subagent",
        );
        if (subagentTasks.length === 1) {
          [matchedTaskId, matchedTask] = subagentTasks[0];
        }
      }

      const completionStatus =
        outcome === "ok" || reason === "subagent-complete" ? "completed" : "failed";

      if (matchedTaskId && matchedTask) {
        pendingTasks.delete(matchedTaskId);
        savePending();

        appendLog({
          taskId: matchedTaskId,
          agentId: matchedTask.agentId,
          sessionKey: matchedTask.sessionKey,
          runtime: matchedTask.runtime,
          task: matchedTask.task,
          spawnedAt: matchedTask.spawnedAt,
          status: completionStatus,
          completedAt: endedAt,
          completionSource: "subagent_ended_hook",
          reason,
          outcome,
          targetSessionKey: targetKey,
        });

        api.logger.info(
          `spawn-interceptor: ${matchedTaskId} → ${completionStatus} (subagent_ended, pending=${pendingTasks.size})`,
        );
      } else {
        appendLog({
          event: "subagent_ended",
          targetSessionKey: targetKey,
          targetKind: event.targetKind || "unknown",
          reason,
          outcome,
          agentId: ctx.runId || "?",
          endedAt,
          matchedTask: false,
        });
        api.logger.info(
          `spawn-interceptor: subagent ended (${targetKey}, ${reason}) — no pending match`,
        );
      }
    });

    api.logger.info("spawn-interceptor v2.5.2: all hooks registered, ACP poller interval=15s");
  },

  unregister() {
    if (reaperTimer) {
      clearInterval(reaperTimer);
      reaperTimer = null;
    }
    if (acpPollerTimer) {
      clearInterval(acpPollerTimer);
      acpPollerTimer = null;
    }
    consumedAcpSessionIds.clear();
    pluginLogger = null;
  },
};

export default spawnInterceptorPlugin;
