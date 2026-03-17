// Main local wrapper server: serves the UI, bridges gateway chat, and exposes
// local helper endpoints for project files, camera telemetry, and gesture control.
//
// This file now stays intentionally small: route wiring and lifecycle live here,
// while file access, gesture/camera logic, static serving, and gateway RPC are
// split into focused helper modules under src/server/.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';
import { APP_DISPLAY_NAME, CLIENT_CONFIG, DATA_DIR, DEBUG_DIR, DEFAULT_CLAUDE_CWD, GATEWAY_PROFILE, LAUNCHD_LABEL, OPENCLAW_BIN, OPENCLAW_DIST_BUILD_INFO, OPENCLAW_REPO_ROOT, PNPM_BIN, ROADMAP_DATA_PATH, ROADMAP_HISTORY_DATA_PATH, ROOT, wrapperPort } from './config.mjs';
import { onAssistantFinal, onAssistantError } from './moodBridge.mjs';
import { sendJson } from './server/httpUtils.mjs';
import { listProjectFiles, readProjectFile, writeProjectFile, safeProjectPath } from './server/filesystem.mjs';
import { getSafeEditState, performStartupRecovery, runSafeEditSmokeSummary } from './server/safeEdit.mjs';
import { getCameraTelemetry, getGestureRuntimeState, runCameraCapture, runGestureCycle, runGesturePipeline, updateGestureWatcher } from './server/gesture.mjs';
import { serveCameraAsset, servePublicFile } from './server/static.mjs';
import { GatewayBridge } from './server/gatewayBridge.mjs';
import { readJsonRequest } from './server/httpUtils.mjs';
import { buildRoadmapFromReply, stripStructuredRoadmapBlock } from './server/utils.mjs';
import { getClaudeState, resizeClaudeSession, restartClaudeSession, sendClaudeInput, startClaudeSession, stopClaudeSession } from './server/claudeTerminal.mjs';
import { evaluateSetupState } from './server/setupState.mjs';
import { handleSetupAction } from './server/setupActions.mjs';

const terminalSessions = new Map();
const MAX_TERMINAL_SESSIONS = 5;

function resolveInteractiveShell() {
  const candidates = ['/bin/bash', '/bin/sh', process.env.SHELL, '/bin/zsh'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {return candidate;}
    } catch {}
  }
  return '/bin/sh';
}

function getOrCreateTerminalSession(sessionId = 'default', cwdRel = '.') {
  const existing = terminalSessions.get(sessionId);
  if (existing && !existing.exited) {return existing;}
  if (!terminalSessions.has(sessionId) && terminalSessions.size >= MAX_TERMINAL_SESSIONS) {
    throw new Error(`Max terminal sessions (${MAX_TERMINAL_SESSIONS}) reached`);
  }
  const cwd = safeProjectPath(cwdRel);
  const shellPath = resolveInteractiveShell();
  const shellArgs = shellPath.endsWith('/sh') ? ['-i'] : ['-i'];
  const child = spawn(shellPath, shellArgs, { cwd, env: process.env, stdio: 'pipe' });
  const state = {
    id: sessionId,
    cwdRel,
    child,
    shellPath,
    output: '',
    exited: false,
    exitCode: null,
    status: 'running',
    terminationRequestedAt: null,
    terminatedAt: null,
    terminationError: null,
  };
  const append = chunk => {
    state.output += String(chunk || '');
    if (state.output.length > 20000) {state.output = state.output.slice(-20000);}
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('error', error => {
    state.output += `\n[terminal spawn error] ${error?.message || String(error)}\n`;
    state.exited = true;
    state.exitCode = null;
    state.status = 'failed';
    state.terminationError = error?.message || String(error);
    state.terminatedAt = state.terminatedAt || new Date().toISOString();
  });
  child.on('exit', code => {
    state.exited = true;
    state.exitCode = code;
    if (state.status === 'terminating') {
      state.status = 'terminated';
      state.terminatedAt = state.terminatedAt || new Date().toISOString();
    } else if (state.status !== 'failed') {
      state.status = 'exited';
    }
  });
  terminalSessions.set(sessionId, state);
  return state;
}


function loadDistBuildInfo() {
  try {
    if (!fs.existsSync(OPENCLAW_DIST_BUILD_INFO)) {return null;}
    return JSON.parse(fs.readFileSync(OPENCLAW_DIST_BUILD_INFO, 'utf8'));
  } catch {
    return null;
  }
}

function loadRoadmapData() {
  try {
    if (!fs.existsSync(ROADMAP_DATA_PATH)) {return null;}
    return JSON.parse(fs.readFileSync(ROADMAP_DATA_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveRoadmapData(payload) {
  const dir = DATA_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ROADMAP_DATA_PATH, JSON.stringify(payload, null, 2), 'utf8');
}


function loadRoadmapHistory() {
  try {
    if (!fs.existsSync(ROADMAP_HISTORY_DATA_PATH)) {return [];}
    const raw = JSON.parse(fs.readFileSync(ROADMAP_HISTORY_DATA_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveRoadmapHistory(items) {
  const dir = DATA_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ROADMAP_HISTORY_DATA_PATH, JSON.stringify(items, null, 2), 'utf8');
}

function pushRoadmapHistory(previousRoadmap) {
  if (!previousRoadmap || !previousRoadmap.id) {return;}
  const history = loadRoadmapHistory();
  if (history.some(item => item?.id === previousRoadmap.id)) {return;}
  history.unshift(previousRoadmap);
  saveRoadmapHistory(history.slice(0, 60));
}

function roadmapHasItems(roadmap) {
  return !!(roadmap && Array.isArray(roadmap.items) && roadmap.items.length);
}

function choosePersistedRoadmap(nextRoadmap, previousRoadmap) {
  if (nextRoadmap?.sourceType === 'assistant-structured') {
    return {
      roadmap: nextRoadmap,
      reason: roadmapHasItems(nextRoadmap) ? 'updated-structured' : 'accepted-empty-structured',
      replacedPrevious: !!(previousRoadmap && previousRoadmap.id !== nextRoadmap.id),
    };
  }
  if (roadmapHasItems(nextRoadmap)) {
    return {
      roadmap: nextRoadmap,
      reason: 'updated',
      replacedPrevious: !!(previousRoadmap && previousRoadmap.id !== nextRoadmap.id),
    };
  }
  if (roadmapHasItems(previousRoadmap)) {
    return {
      roadmap: previousRoadmap,
      reason: 'preserved-previous-non-empty',
      replacedPrevious: false,
    };
  }
  return {
    roadmap: nextRoadmap,
    reason: 'accepted-empty-no-previous',
    replacedPrevious: false,
  };
}

const clients = new Set();
const seenFinalRunIds = new Set();
const activeRunSeq = new Map();
let runSequence = 0;
let lastRouting = { mode: 'n/a', detail: 'no final reply routed yet' };
let runtimeState = {
  mood: 'idle',
  phase: 'idle',
  activeRunId: null,
  activeRunCount: 0,
  latestRunSeq: 0,
  bodyState: null,
  lightOutput: 'idle',
  source: 'bootstrap',
  updatedAt: new Date().toISOString(),
};
let tokenStats = {
  last: null,
  totalInput: 0,
  totalOutput: 0,
  totalCacheRead: 0,
  totalCacheWrite: 0,
  total: 0,
  baselineReady: false,
  modelName: null,
  modelProvider: null,
  modelLimit: null,
  modelUsagePercent: null,
  contextSnapshot: null,
  diagnosticContext: null,
};

function normalizeMood(mode) {
  if (mode === 'thinking' || mode === 'streaming' || mode === 'waiting' || mode === 'error') {return mode;}
  return 'idle';
}

function computeVisualState({ mood, phase, bodyState, activeRunCount }) {
  const currentStatus = bodyState?.current_status || null;
  const lightOutput = bodyState?.light_output || null;
  if (phase === 'error' || mood === 'error' || currentStatus === 'error' || lightOutput === 'error') {return 'error';}
  if (activeRunCount > 0 || phase === 'queued' || phase === 'streaming' || mood === 'thinking' || mood === 'streaming') {return 'thinking';}
  if (mood === 'waiting' || currentStatus === 'waiting' || lightOutput === 'waiting') {return 'waiting';}
  if (currentStatus === 'thinking' || lightOutput === 'thinking') {return 'thinking';}
  return normalizeMood(mood || currentStatus || lightOutput || 'idle');
}

function syncRuntimeState(patch = {}) {
  runtimeState = {
    ...runtimeState,
    ...patch,
    bodyState: patch.bodyState === undefined ? runtimeState.bodyState : patch.bodyState,
  };
  runtimeState.activeRunCount = activeRunSeq.size;

  const bodyCurrent = runtimeState.bodyState?.current_status || null;
  const bodyLight = runtimeState.bodyState?.light_output || null;
  if (runtimeState.activeRunCount === 0) {
    runtimeState.activeRunId = null;
    if (bodyCurrent === 'idle' || bodyLight === 'idle') {
      runtimeState.mood = 'idle';
      runtimeState.phase = 'idle';
    } else if (bodyCurrent === 'waiting' || bodyLight === 'waiting') {
      runtimeState.mood = 'waiting';
      runtimeState.phase = 'idle';
    }
  }

  runtimeState.lightOutput = computeVisualState(runtimeState);
  runtimeState.updatedAt = new Date().toISOString();
  return runtimeState;
}

function buildMoodPacket(mode, extra = {}) {
  const mergedState = syncRuntimeState({
    mood: normalizeMood(mode),
    phase: extra.phase ?? runtimeState.phase,
    activeRunId: extra.runId ?? runtimeState.activeRunId,
    bodyState: extra.state === undefined ? runtimeState.bodyState : extra.state,
    source: extra.source ?? runtimeState.source,
  });
  return {
    type: 'mood',
    mode: mergedState.lightOutput,
    state: mergedState.bodyState ?? null,
    runtime: mergedState,
    detail: {
      mode: mergedState.lightOutput,
      detail: extra.detail ?? 'n/a',
      preview: extra.preview ?? '',
      phase: mergedState.phase ?? null,
      runId: extra.runId ?? null,
      source: mergedState.source,
    },
  };
}

function broadcast(packet) {
  const data = JSON.stringify(packet);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {ws.send(data);}
  }
}

function buildTokensPacket() {
  return {
    type: 'tokens',
    last: tokenStats.last,
    totalInput: tokenStats.totalInput,
    totalOutput: tokenStats.totalOutput,
    totalCacheRead: tokenStats.totalCacheRead,
    totalCacheWrite: tokenStats.totalCacheWrite,
    total: tokenStats.total,
    modelName: tokenStats.modelName,
    modelProvider: tokenStats.modelProvider,
    modelLimit: tokenStats.modelLimit,
    modelUsagePercent: tokenStats.modelUsagePercent,
    contextSnapshot: tokenStats.contextSnapshot,
    diagnosticContext: tokenStats.diagnosticContext,
  };
}

const startupRecovery = performStartupRecovery();
if (startupRecovery.recovered.length || startupRecovery.warnings.length) {
  console.log('[wrapper] startup recovery', JSON.stringify(startupRecovery));
}

const bridge = new GatewayBridge({
  onStatus: payload => broadcast({ type: 'status', ...payload }),
  onDiagnosticEvent: event => {
    const used = typeof event?.context?.used === 'number' ? event.context.used : null;
    const limit = typeof event?.context?.limit === 'number' ? event.context.limit : null;
    tokenStats.diagnosticContext = {
      used,
      limit,
      pct: used != null && limit ? Math.min(100, Math.round((used / limit) * 1000) / 10) : null,
      sessionKey: event?.sessionKey || null,
      model: event?.model || null,
      provider: event?.provider || null,
      ts: typeof event?.ts === 'number' ? event.ts : Date.now(),
    };
    broadcast(buildTokensPacket());
  },
  onQueuedMood: (runId, sidecarResult = null) => {
    if (runId) {
      runSequence += 1;
      activeRunSeq.set(runId, runSequence);
    }
    syncRuntimeState({
      mood: 'thinking',
      phase: 'queued',
      activeRunId: runId || runtimeState.activeRunId,
      latestRunSeq: runSequence,
      bodyState: sidecarResult?.state ?? runtimeState.bodyState,
      source: 'queued',
    });
    broadcast(buildMoodPacket('thinking', {
      detail: 'task-start sent to sidecar',
      phase: 'queued',
      runId,
      state: sidecarResult?.state ?? runtimeState.bodyState ?? { current_status: 'thinking', last_stable_status: 'thinking', light_output: 'thinking' },
      source: 'queued',
    }));
  },
  onChatEvent: async event => {
    if (event.state === 'final' || event.state === 'error' || event.state === 'aborted') {
      try {
        const latest = await bridge.fetchSessionUsage();
        if (latest) {
          const prev = {
            input: tokenStats.totalInput,
            output: tokenStats.totalOutput,
            cacheRead: tokenStats.totalCacheRead,
            cacheWrite: tokenStats.totalCacheWrite,
            total: tokenStats.total,
          };
          tokenStats.totalInput = latest.input;
          tokenStats.totalOutput = latest.output;
          tokenStats.totalCacheRead = latest.cacheRead;
          tokenStats.totalCacheWrite = latest.cacheWrite;
          tokenStats.total = latest.total;
          tokenStats.modelName = latest.model;
          tokenStats.modelProvider = latest.provider;
          tokenStats.last = tokenStats.baselineReady ? {
            input: Math.max(0, latest.input - prev.input),
            output: Math.max(0, latest.output - prev.output),
            cacheRead: Math.max(0, latest.cacheRead - prev.cacheRead),
            cacheWrite: Math.max(0, latest.cacheWrite - prev.cacheWrite),
            total: Math.max(0, latest.total - prev.total),
          } : null;
          tokenStats.baselineReady = true;
          try {
            const [models, snapshot] = await Promise.all([
              bridge.fetchModelCatalog(),
              bridge.fetchSessionContextSnapshot(),
            ]);
            const match = models.find(model => {
              const name = typeof model?.id === 'string' ? model.id : (typeof model?.model === 'string' ? model.model : null);
              const provider = typeof model?.provider === 'string' ? model.provider : null;
              return name === latest.model && (!latest.provider || !provider || provider === latest.provider);
            });
            const limit = Number(match?.contextWindow ?? match?.context_window ?? match?.limit ?? 0) || null;
            tokenStats.modelLimit = limit;
            const estimatedPromptLoad = tokenStats.last ? ((tokenStats.last.input || 0) + (tokenStats.last.cacheRead || 0)) : null;
            tokenStats.modelUsagePercent = (limit && estimatedPromptLoad != null)
              ? Math.min(100, Math.round((estimatedPromptLoad / limit) * 1000) / 10)
              : null;
            tokenStats.contextSnapshot = snapshot ? {
              used: typeof snapshot.totalTokens === 'number' ? snapshot.totalTokens : null,
              limit: typeof snapshot.contextTokens === 'number' ? snapshot.contextTokens : null,
              fresh:  snapshot.totalTokensFresh,
              model: snapshot.model,
              provider: snapshot.provider,
              sessionKey: snapshot.key,
              pct: typeof snapshot.totalTokens === 'number' && typeof snapshot.contextTokens === 'number' && snapshot.contextTokens > 0
                ? Math.min(100, Math.round((snapshot.totalTokens / snapshot.contextTokens) * 1000) / 10)
                : null,
            } : null;
          } catch (error) {
            console.log('[wrapper] models.list / sessions.list fetch failed', error?.message || String(error));
          }
          console.log('[wrapper] usage refresh:', JSON.stringify({ last: tokenStats.last, total: latest, limit: tokenStats.modelLimit, pct: tokenStats.modelUsagePercent, contextSnapshot: tokenStats.contextSnapshot, diagnosticContext: tokenStats.diagnosticContext }));
          broadcast(buildTokensPacket());
        }
      } catch (error) {
        console.log('[wrapper] sessions.usage fetch failed', error?.message || String(error));
      }
    }

    const rawReplyText = typeof event?.rawText === 'string'
      ? event.rawText
      : (typeof event?.text === 'string' ? event.text : '');
    const visibleReplyText = event.state === 'final' ? stripStructuredRoadmapBlock(rawReplyText) : rawReplyText;
    const isEmptyFinal = event.state === 'final' && !String(visibleReplyText || '').trim();
    const isDuplicateFinal = event.state === 'final' && !!event.runId && seenFinalRunIds.has(event.runId);
    const clientEvent = (event && typeof event === 'object') ? { ...event, text: visibleReplyText } : event;

    if (!(isEmptyFinal || isDuplicateFinal)) {broadcast({ type: 'chat', event: clientEvent });}
    if (event.state === 'delta') {
      syncRuntimeState({
        mood: 'thinking',
        phase: 'streaming',
        activeRunId: event.runId || runtimeState.activeRunId,
        source: 'chat-delta',
      });
      broadcast(buildMoodPacket('thinking', {
        detail: 'assistant streaming',
        preview: (event.text || '').slice(0, 120),
        phase: 'streaming',
        runId: event.runId,
        source: 'chat-delta',
      }));
      return;
    }

    if (event.state === 'final') {
      if (isEmptyFinal) {
        console.log('[wrapper] ignored empty final event', event.runId || 'no-run-id');
        return;
      }
      if (isDuplicateFinal) {
        console.log('[wrapper] ignored duplicate final event', event.runId);
        return;
      }
      if (event.runId) {
        seenFinalRunIds.add(event.runId);
        if (seenFinalRunIds.size > 200) {seenFinalRunIds.clear();}
      }
      const finishedSeq = event.runId ? activeRunSeq.get(event.runId) || 0 : 0;
      if (event.runId) {activeRunSeq.delete(event.runId);}
      syncRuntimeState({
        activeRunId: activeRunSeq.size ? runtimeState.activeRunId : null,
        source: 'chat-final',
      });
      try {
        const replyBody = stripStructuredRoadmapBlock(rawReplyText || '');
        const preview = replyBody.slice(0, 220);
        console.log('[wrapper] final reply preview:', preview);
        const extractedRoadmap = buildRoadmapFromReply(rawReplyText || '');
        const previousRoadmap = loadRoadmapData();
        const roadmapDecision = choosePersistedRoadmap(extractedRoadmap, previousRoadmap);
        const roadmap = roadmapDecision.roadmap;
        if (roadmapDecision.replacedPrevious && previousRoadmap) {pushRoadmapHistory(previousRoadmap);}
        saveRoadmapData(roadmap);
        console.log('[wrapper] roadmap source:', roadmap.sourceType, 'items:', roadmap.items?.length || 0, 'decision:', roadmapDecision.reason);
        broadcast({ type: 'roadmap', roadmap, decision: roadmapDecision.reason, extractedRoadmap });

        const newerRunStillActive = activeRunSeq.size > 0 && finishedSeq < runSequence;
        if (newerRunStillActive) {
          lastRouting = {
            mode: 'thinking',
            detail: `final for older run ignored while newer run is active (${activeRunSeq.size} active)`,
            preview,
            phase: 'streaming',
            runId: event.runId,
          };
          syncRuntimeState({ mood: 'thinking', phase: 'streaming', source: 'chat-final-suppressed' });
          broadcast(buildMoodPacket('thinking', {
            state: runtimeState.bodyState,
            detail: lastRouting.detail,
            preview,
            phase: 'streaming',
            runId: event.runId,
            source: 'chat-final-suppressed',
          }));
          return;
        }

        const result = await onAssistantFinal(replyBody || '');
        lastRouting = {
          mode: result?.mode ?? 'unknown',
          detail: `final length=${replyBody.length}`,
          preview,
          phase: 'final',
          runId: event.runId,
        };
        broadcast(buildMoodPacket(result?.mode ?? 'unknown', {
          state: result?.state ?? null,
          detail: lastRouting.detail,
          preview,
          phase: 'final',
          runId: event.runId,
          source: 'chat-final',
        }));
      } catch (error) {
        lastRouting = { mode: 'error', detail: error?.message || String(error), phase: 'final', runId: event.runId };
        console.log('[wrapper] sidecar final routing failed', error?.message || String(error));
        broadcast(buildMoodPacket('error', {
          detail: lastRouting.detail,
          phase: 'final',
          runId: event.runId,
          source: 'chat-final-error',
        }));
      }
    } else if (event.state === 'error') {
      if (event.runId) {activeRunSeq.delete(event.runId);}
      syncRuntimeState({ source: 'chat-error' });
      try {
        const result = await onAssistantError();
        lastRouting = { mode: 'error', detail: event.payload?.errorMessage || 'chat error', phase: 'error', runId: event.runId };
        broadcast(buildMoodPacket('error', {
          state: result?.state ?? runtimeState.bodyState,
          detail: lastRouting.detail,
          phase: 'error',
          runId: event.runId,
          source: 'chat-error',
        }));
      } catch (error) {
        console.log('[wrapper] sidecar error routing failed', error?.message || String(error));
      }
    } else if (event.state === 'aborted') {
      if (event.runId) {activeRunSeq.delete(event.runId);}
      lastRouting = { mode: activeRunSeq.size ? 'thinking' : 'idle', detail: 'chat aborted', phase: 'aborted', runId: event.runId };
      broadcast(buildMoodPacket(activeRunSeq.size ? 'thinking' : 'idle', {
        state: runtimeState.bodyState,
        detail: 'chat aborted',
        phase: activeRunSeq.size ? 'streaming' : 'aborted',
        runId: event.runId,
        source: 'chat-aborted',
      }));
    }
  },
});
bridge.connect();

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${wrapperPort}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (requestUrl.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      service: APP_DISPLAY_NAME,
      port: wrapperPort,
      gatewayConnected: bridge.connected,
      startupRecovery: {
        recovered: startupRecovery.recovered.length,
        warnings: startupRecovery.warnings.length,
      },
    });
    return;
  }

  if (requestUrl.pathname === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, config: CLIENT_CONFIG });
    return;
  }

  if (requestUrl.pathname === '/api/setup/state' && req.method === 'GET') {
    const claudeState = getClaudeState();
    sendJson(res, 200, evaluateSetupState({ bridgeConnected: bridge.connected, claudeState }));
    return;
  }

  if (requestUrl.pathname === '/api/setup/action' && req.method === 'POST') {
    readJsonRequest(req)
      .then(async body => {
        const action = body && typeof body.action === 'string' ? body.action.trim() : '';
        if (!action) {
          sendJson(res, 400, { ok: false, error: 'missing "action" field' });
          return;
        }
        const result = await handleSetupAction({
          action,
          bridgeConnected: bridge.connected,
          claudeState: getClaudeState(),
        });
        // dashboard-service-restart: send response first, then schedule the restart.
        const shouldReload = result._reload === true;
        const { _reload: _, ...safeResult } = result;
        sendJson(res, shouldReload ? 202 : 200, safeResult);
        if (shouldReload) {
          setTimeout(() => {
            // Setup wizard reload only needs a service restart, not a full
            // bootout/bootstrap cycle. Running reload.sh from inside the
            // launchd-managed wrapper can unload the current job before the
            // helper finishes, leaving the dashboard down. `kickstart -k`
            // restarts the existing job in place and is safe to trigger here.
            execFile('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LAUNCHD_LABEL}`], { cwd: ROOT }, () => {});
          }, 120);
        }
      })
      .catch(error => sendJson(res, 400, { ok: false, error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/dist-info' && req.method === 'GET') {
    const info = loadDistBuildInfo();
    sendJson(res, 200, { ok: true, info });
    return;
  }

  if (requestUrl.pathname === '/api/dist-rebuild' && req.method === 'POST') {
    readJsonRequest(req)
      .then(() => {
        sendJson(res, 202, { ok: true, rebuilding: true });
        setTimeout(() => {
          execFile(PNPM_BIN, ['build'], { cwd: OPENCLAW_REPO_ROOT, env: process.env }, () => {});
        }, 120);
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/safe-edit/state' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      ...getSafeEditState(),
      startupRecovery,
      smoke: runSafeEditSmokeSummary(),
    });
    return;
  }

  if (requestUrl.pathname === '/api/roadmap' && req.method === 'GET') {
    const roadmap = loadRoadmapData();
    sendJson(res, 200, { ok: true, roadmap });
    return;
  }

  if (requestUrl.pathname === '/api/coms/token-saver' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, tokenSaver: bridge.getTokenSaverSnapshot() });
    return;
  }

  if (requestUrl.pathname === '/api/coms/token-saver' && req.method === 'POST') {
    readJsonRequest(req)
      .then(payload => {
        const tokenSaver = bridge.setTokenSaverConfig({
          ...(typeof payload?.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
          ...(typeof payload?.phase1Summary === 'boolean' ? { phase1Summary: payload.phase1Summary } : {}),
          ...(typeof payload?.phase2ToolCompression === 'boolean' ? { phase2ToolCompression: payload.phase2ToolCompression } : {}),
        });
        broadcast({ type: 'token-saver', tokenSaver });
        sendJson(res, 200, { ok: true, tokenSaver });
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/coms/token-saver/stats' && req.method === 'GET') {
    const snapshot = bridge.getTokenSaverSnapshot();
    sendJson(res, 200, {
      ok: true,
      stats: snapshot?.stats || null,
      lastSend: snapshot?.lastSend || null,
      memory: snapshot?.memory || { summary: '', turnCount: 0, recentTurns: [] },
      lastAssistantFinal: snapshot?.lastAssistantFinal || null,
    });
    return;
  }

  if (requestUrl.pathname === '/api/coms/token-saver/runs' && req.method === 'GET') {
    try {
      const debugDir = DEBUG_DIR;
      const indexPath = `${debugDir}/run-index.json`;
      const items = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : [];
      sendJson(res, 200, { ok: true, items: Array.isArray(items) ? items : [] });
    } catch (error) {
      sendJson(res, 500, { error: error?.message || String(error) });
    }
    return;
  }

  if (requestUrl.pathname === '/api/coms/token-saver/run' && req.method === 'GET') {
    try {
      const runId = String(requestUrl.searchParams.get('runId') || '').trim();
      if (!runId) {throw new Error('runId is required');}
      const debugDir = DEBUG_DIR;
      const runDir = `${debugDir}/${runId}`;
      const readJson = name => {
        const p = `${runDir}/${name}.json`;
        return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
      };
      sendJson(res, 200, {
        ok: true,
        runId,
        before: readJson('before'),
        after: readJson('after'),
        diffSummary: readJson('diff-summary'),
      });
    } catch (error) {
      sendJson(res, 400, { error: error?.message || String(error) });
    }
    return;
  }

  if (requestUrl.pathname === '/api/roadmap/history' && req.method === 'GET') {
    const items = loadRoadmapHistory();
    sendJson(res, 200, { ok: true, items });
    return;
  }

  if (requestUrl.pathname === '/api/roadmap/history/clear' && req.method === 'POST') {
    readJsonRequest(req)
      .then(payload => {
        if (payload?.confirm !== true) {throw new Error('confirm=true is required to clear roadmap history');}
        saveRoadmapHistory([]);
        broadcast({ type: 'roadmap.history.cleared' });
        sendJson(res, 200, { ok: true, cleared: true, count: 0 });
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/tasks/deploy' && req.method === 'POST') {
    readJsonRequest(req)
      .then(async payload => {
        const task = payload?.task && typeof payload.task === 'object' ? payload.task : {};
        const title = String(task.title || task.text || '').trim();
        if (!title) {throw new Error('task title is required');}
        const description = String(task.description || '').trim();
        const priority = String(task.priority || 'normal');
        const status = String(task.status || 'todo');
        const source = String(task.source || 'task-board');
        const lines = [
          'Deployed task from telemetry Task Board:',
          `Title: ${title}`,
          `Priority: ${priority}`,
          `Status: ${status}`,
          `Source: ${source}`,
        ];
        if (description) {lines.push(`Description: ${description}`);}
        lines.push('', 'Please continue by working on this task or proposing the immediate next concrete action.');
        const message = lines.join('\n');
        const dryRun = !!payload?.dryRun;
        if (dryRun) {
          sendJson(res, 200, { ok: true, dryRun: true, runId: null, message });
          return;
        }
        const runId = await bridge.sendChat(message);
        broadcast({ type: 'task.deploy', task: { ...task, title, description, priority, status, source }, runId });
        sendJson(res, 200, { ok: true, dryRun: false, runId, message });
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }


  if (requestUrl.pathname === '/api/tasks/deploy-batch' && req.method === 'POST') {
    readJsonRequest(req)
      .then(async payload => {
        const tasks = Array.isArray(payload?.tasks) ? payload.tasks.filter(task => task && typeof task === 'object') : [];
        if (tasks.length < 2) {throw new Error('at least two tasks are required for batch deploy');}
        const normalizedTasks = tasks.map((task, index) => {
          const title = String(task.title || task.text || '').trim();
          if (!title) {throw new Error(`task ${index + 1} title is required`);}
          return {
            ...task,
            title,
            description: String(task.description || '').trim(),
            priority: String(task.priority || 'normal'),
            status: String(task.status || 'todo'),
            source: String(task.source || 'task-board'),
          };
        });
        const batchId = String(payload?.batchId || `batch-${Date.now()}`);
        const deployedAt = new Date().toISOString();
        const lines = [
          'Batch deployed tasks from telemetry Task Board:',
          `Batch ID: ${batchId}`,
          `Task Count: ${normalizedTasks.length}`,
          '',
          'Treat each task as a separate entity. Do not merge them. Work through them as a coordinated batch and call out immediate next actions per task.',
          '',
          'Tasks:',
        ];
        for (const [index, task] of normalizedTasks.entries()) {
          lines.push(`${index + 1}. Title: ${task.title}`);
          lines.push(`   Priority: ${task.priority}`);
          lines.push(`   Status: ${task.status}`);
          lines.push(`   Source: ${task.source}`);
          if (task.description) {lines.push(`   Description: ${task.description}`);}
          if (task.roadmapItemId) {lines.push(`   Roadmap Item ID: ${task.roadmapItemId}`);}
          if (task.id) {lines.push(`   Task ID: ${task.id}`);}
        }
        lines.push('', 'Please continue by working on this batch while preserving separate task identities, reporting progress per task, and proposing the immediate next concrete action for the batch.');
        const message = lines.join('\n');
        const dryRun = !!payload?.dryRun;
        if (dryRun) {
          sendJson(res, 200, { ok: true, dryRun: true, runId: null, batchId, deployedAt, message, tasks: normalizedTasks });
          return;
        }
        const runId = await bridge.sendChat(message);
        broadcast({ type: 'task.batch_deploy', batchId, deployedAt, tasks: normalizedTasks, runId });
        sendJson(res, 200, { ok: true, dryRun: false, runId, batchId, deployedAt, message, tasks: normalizedTasks });
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/files' && req.method === 'GET') {
    try {
      sendJson(res, 200, listProjectFiles(requestUrl.searchParams.get('dir') || '.'));
    } catch (error) {
      sendJson(res, 500, { error: error?.message || String(error) });
    }
    return;
  }

  if (requestUrl.pathname === '/api/file' && req.method === 'GET') {
    try {
      sendJson(res, 200, readProjectFile(requestUrl.searchParams.get('path') || ''));
    } catch (error) {
      sendJson(res, 400, { error: error?.message || String(error) });
    }
    return;
  }

  if (requestUrl.pathname === '/api/file' && req.method === 'POST') {
    readJsonRequest(req)
      .then(payload => sendJson(res, 200, writeProjectFile(payload.path || '', typeof payload.content === 'string' ? payload.content : '')))
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/explorer/open' && req.method === 'POST') {
    readJsonRequest(req)
      .then(payload => {
        const targetDir = safeProjectPath(typeof payload.dir === 'string' && payload.dir ? payload.dir : '.');
        execFile('open', [targetDir], error => {
          if (error) {sendJson(res, 500, { error: error?.message || error?.code || 'open failed' });}
          else {sendJson(res, 200, { ok: true, dir: targetDir });}
        });
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/run-mode' && req.method === 'GET') {
    try {
      const modeFile = path.join(ROOT, 'launchd', '.run-mode');
      const mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() || 'source' : 'source';
      sendJson(res, 200, { ok: true, mode });
    } catch (error) {
      sendJson(res, 500, { error: error?.message || String(error) });
    }
    return;
  }

  if (requestUrl.pathname === '/api/run-mode' && req.method === 'POST') {
    readJsonRequest(req)
      .then(payload => {
        const mode = payload?.mode === 'runtime' ? 'runtime' : 'source';
        const script = path.join(ROOT, 'launchd', 'set-mode.sh');
        sendJson(res, 202, { ok: true, mode, switching: true });
        setTimeout(() => {
          execFile('/bin/bash', [script, mode], { cwd: ROOT }, () => {});
        }, 120);
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/wrapper/restart' && req.method === 'POST') {
    readJsonRequest(req)
      .then(() => {
        const script = path.join(ROOT, 'launchd', 'reload.sh');
        sendJson(res, 202, { ok: true, restarting: true, target: 'wrapper' });
        setTimeout(() => {
          execFile('/bin/bash', [script], { cwd: ROOT }, () => {});
        }, 120);
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/context/compact' && req.method === 'POST') {
    readJsonRequest(req)
      .then(async () => {
        const result = await bridge.compactSession();
        broadcast({ type: 'context.compacted', result });
        sendJson(res, 200, { ok: true, result });
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/gateway/restart' && req.method === 'POST') {
    readJsonRequest(req)
      .then(() => {
        sendJson(res, 202, { ok: true, restarting: true, target: 'gateway', profile: GATEWAY_PROFILE });
        setTimeout(() => {
          execFile(OPENCLAW_BIN, ['--profile', GATEWAY_PROFILE, 'gateway', 'restart'], { cwd: ROOT, env: process.env }, () => {});
        }, 120);
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/claude/state' && req.method === 'GET') {
    try {
      const cwdRel = requestUrl.searchParams.get('cwd') || DEFAULT_CLAUDE_CWD;
      sendJson(res, 200, getClaudeState({ cwdRel }));
    } catch (error) {
      sendJson(res, 400, { error: error?.message || String(error) });
    }
    return;
  }


  if (requestUrl.pathname === '/api/claude/start' && req.method === 'POST') {
    readJsonRequest(req)
      .then(payload => {
        const cwdRel = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : DEFAULT_CLAUDE_CWD;
        const state = startClaudeSession({ cwdRel });
        sendJson(res, 200, state);
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/claude/input' && req.method === 'POST') {
    readJsonRequest(req)
      .then(payload => {
        const text = String(payload?.text || '');
        if (!text.length) {throw new Error('text is required');}
        const cwdRel = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : DEFAULT_CLAUDE_CWD;
        const state = sendClaudeInput({ text, cwdRel, raw: !!payload?.raw });
        sendJson(res, 200, state);
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/claude/stop' && req.method === 'POST') {
    readJsonRequest(req)
      .then(() => {
        sendJson(res, 200, stopClaudeSession());
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/claude/restart' && req.method === 'POST') {
    readJsonRequest(req)
      .then(async payload => {
        const cwdRel = typeof payload?.cwd === 'string' && payload.cwd ? payload.cwd : DEFAULT_CLAUDE_CWD;
        const state = await restartClaudeSession({ cwdRel });
        sendJson(res, 200, state);
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/claude/resize' && req.method === 'POST') {
    readJsonRequest(req)
      .then(payload => {
        const state = resizeClaudeSession({ cols: payload?.cols, rows: payload?.rows });
        sendJson(res, 200, state);
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/terminal/session' && req.method === 'GET') {
    const session = getOrCreateTerminalSession('default', requestUrl.searchParams.get('cwd') || '.');
    sendJson(res, 200, { ok: true, sessionId: session.id, cwd: session.cwdRel, output: session.output, exited: session.exited, exitCode: session.exitCode });
    return;
  }

  if (requestUrl.pathname === '/api/terminal/input' && req.method === 'POST') {
    readJsonRequest(req)
      .then(payload => {
        const session = getOrCreateTerminalSession(String(payload.sessionId || 'default'), typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : '.');
        const text = String(payload.text || '');
        session.child.stdin.write(text);
        setTimeout(() => {
          const toolLabel = `terminal ${session.cwdRel || '.'} $ ${text.trim() || '<empty>'}`;
          bridge.ingestToolResult(toolLabel, session.output || '', { sessionId: session.id, cwdRel: session.cwdRel });
          sendJson(res, 200, {
            ok: true,
            sessionId: session.id,
            output: session.output,
            exited: session.exited,
            exitCode: session.exitCode,
            status: session.status,
            terminationRequestedAt: session.terminationRequestedAt,
            terminatedAt: session.terminatedAt,
            terminationError: session.terminationError,
          });
        }, 120);
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/terminal/terminate' && req.method === 'POST') {
    readJsonRequest(req)
      .then(payload => {
        const sessionId = String(payload?.sessionId || 'default');
        const session = terminalSessions.get(sessionId);
        if (!session) {throw new Error(`terminal session not found: ${sessionId}`);}
        if (session.exited || !session.child || session.child.killed) {
          session.status = session.status === 'terminated' ? 'terminated' : 'exited';
          sendJson(res, 200, {
            ok: true,
            sessionId: session.id,
            status: session.status,
            exited: session.exited,
            exitCode: session.exitCode,
            terminationRequestedAt: session.terminationRequestedAt,
            terminatedAt: session.terminatedAt,
            terminationError: session.terminationError,
          });
          return;
        }
        session.status = 'terminating';
        session.terminationRequestedAt = new Date().toISOString();
        session.terminationError = null;
        try {
          session.child.kill('SIGTERM');
        } catch (error) {
          session.status = 'failed';
          session.terminationError = error?.message || String(error);
        }
        setTimeout(() => {
          if (!session.exited && session.child && !session.child.killed) {
            try {
              session.child.kill('SIGKILL');
            } catch (error) {
              session.status = 'failed';
              session.terminationError = error?.message || String(error);
            }
          }
          if (session.exited && session.status === 'terminating') {
            session.status = 'terminated';
            session.terminatedAt = session.terminatedAt || new Date().toISOString();
          }
          sendJson(res, 200, {
            ok: !session.terminationError,
            sessionId: session.id,
            status: session.status,
            exited: session.exited,
            exitCode: session.exitCode,
            terminationRequestedAt: session.terminationRequestedAt,
            terminatedAt: session.terminatedAt,
            terminationError: session.terminationError,
          });
        }, 120);
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/camera' && req.method === 'GET') {
    try {
      sendJson(res, 200, getCameraTelemetry());
    } catch (error) {
      sendJson(res, 500, { error: error?.message || String(error) });
    }
    return;
  }

  if (requestUrl.pathname === '/api/vio-body-state' && req.method === 'GET') {
    fetch('http://127.0.0.1:8787/api/state')
      .then(async upstream => {
        const data = await upstream.json();
        if (!upstream.ok) {
          sendJson(res, upstream.status || 500, data);
          return;
        }
        syncRuntimeState({ bodyState: data, source: 'vio-body-poll' });
        sendJson(res, 200, {
          ...data,
          effective_light_output: runtimeState.lightOutput,
          wrapper_runtime: runtimeState,
        });
      })
      .catch(error => sendJson(res, 500, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/camera/capture' && req.method === 'POST') {
    runGesturePipeline()
      .then(result => sendJson(res, 200, { ...result, telemetry: getCameraTelemetry() }))
      .catch(error => sendJson(res, 500, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/camera/capture-step' && req.method === 'POST') {
    runCameraCapture()
      .then(result => sendJson(res, 200, { ok: true, capture: result, telemetry: getCameraTelemetry() }))
      .catch(error => sendJson(res, 500, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/camera/recognize-step' && req.method === 'POST') {
    readJsonRequest(req)
      .then(payload => {
        const frameNames = Array.isArray(payload.frameNames) ? payload.frameNames.filter(name => typeof name === 'string') : [];
        return runGestureCycle(Math.max(3, frameNames.length || 3), frameNames)
          .then(({ gesture, action }) => sendJson(res, 200, { ok: true, gesture, action, telemetry: getCameraTelemetry() }));
      })
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname === '/api/gesture/state' && req.method === 'GET') {
    sendJson(res, 200, getGestureRuntimeState());
    return;
  }

  if (requestUrl.pathname === '/api/gesture/watcher' && req.method === 'POST') {
    readJsonRequest(req)
      .then(payload => sendJson(res, 200, { ok: true, gestureRuntime: updateGestureWatcher(payload) }))
      .catch(error => sendJson(res, 400, { error: error?.message || String(error) }));
    return;
  }

  if (requestUrl.pathname.startsWith('/vio_cam/')) {
    serveCameraAsset(requestUrl, res);
    return;
  }

  servePublicFile(requestUrl, res);
});

// Push Claude terminal state to all connected clients when output changes.
let lastBroadcastClaudeOutput = null;
setInterval(() => {
  if (clients.size === 0) {return;}
  try {
    const state = getClaudeState();
    if (state.output !== lastBroadcastClaudeOutput) {
      lastBroadcastClaudeOutput = state.output;
      broadcast({ type: 'claude-state', ...state });
    }
  } catch {}
}, 200);

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'status', connected: bridge.connected, sessionKey: bridge.sessionKey }));
  ws.send(JSON.stringify(buildTokensPacket()));
  try { ws.send(JSON.stringify({ type: 'claude-state', ...getClaudeState() })); } catch {}
  ws.send(JSON.stringify(buildMoodPacket(lastRouting.mode, {
    state: null,
    detail: lastRouting.detail,
    preview: lastRouting.preview,
    phase: lastRouting.phase,
    runId: lastRouting.runId,
  })));
  ws.on('message', async raw => {
    let msg;
    // raw is RawData (Buffer | ArrayBuffer | Buffer[] | string) from ws
    const rawStr = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : JSON.stringify(raw);
    try { msg = JSON.parse(rawStr); } catch { return; }
    if (msg.type === 'send') {
      try {
        console.log('[wrapper] ui send received', JSON.stringify({ textLength: String(msg.text ?? '').length, preview: String(msg.text ?? '').slice(0, 120) }));
        const runId = await bridge.sendChat(String(msg.text ?? ''));
        console.log('[wrapper] ui send accepted', runId);
        ws.send(JSON.stringify({ type: 'ack', runId }));
      } catch (error) {
        console.log('[wrapper] ui send failed', error?.message ?? String(error));
        ws.send(JSON.stringify({ type: 'error', error: error?.message ?? String(error) }));
      }
    }
  });
  ws.on('close', () => clients.delete(ws));
});

server.listen(wrapperPort, () => {
  console.log(`${APP_DISPLAY_NAME} running at http://127.0.0.1:${wrapperPort}`);
});
