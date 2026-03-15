import WebSocket from 'ws';
import { COMS_ROOT, OPENCLAW_DIST_ROOT, TOKEN_SAVER_DEBUG_ROOT, gatewayPort, gatewayToken, gatewayUrl } from '../config.mjs';
import { randomId, parseMessageText, extractUsage } from './utils.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const tokenSaverModule = await import(pathToFileURL(path.join(COMS_ROOT, 'token-saver.mjs')).href);
const { TokenSaver, sanitizeVisibleText, hasRoadmapBlock, simulateTokenSaverView, buildPhaseOneCompressedPrompt } = tokenSaverModule;
import { onUserPrompt } from '../moodBridge.mjs';

const TOKEN_SAVER_DEBUG_DIR = TOKEN_SAVER_DEBUG_ROOT;

function ensureTokenSaverDebugDir() {
  fs.mkdirSync(TOKEN_SAVER_DEBUG_DIR, { recursive: true });
}

function summarizeTokenSaverPayload(payload = '') {
  const lines = String(payload || '').split('\n');
  return {
    chars: String(payload || '').length,
    lines: lines.length,
    head: String(payload || '').slice(0, 220),
    tail: String(payload || '').slice(-220),
    hasRoadmapBlock: hasRoadmapBlock(payload),
  };
}

function writeTokenSaverDebugLog(runId, phase, payload) {
  ensureTokenSaverDebugDir();
  const safeRunId = String(runId || `no-run-${Date.now()}`);
  const runDir = path.join(TOKEN_SAVER_DEBUG_DIR, safeRunId);
  fs.mkdirSync(runDir, { recursive: true });
  const filePath = path.join(runDir, `${phase}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function writeRunIndexEntry(runId, payload = {}) {
  ensureTokenSaverDebugDir();
  const indexPath = path.join(TOKEN_SAVER_DEBUG_DIR, 'run-index.json');
  let current = [];
  try {
    current = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!Array.isArray(current)) {current = [];}
  } catch {
    current = [];
  }

  const allForRun = current.filter(item => item?.runId === runId);
  const previous = allForRun.reduce((acc, item) => ({ ...acc, ...item }), { runId });
  const merged = {
    ...previous,
    ...payload,
    runId,
    indexedAt: new Date().toISOString(),
  };
  const artifacts = [merged.beforeLogPath, merged.afterLogPath, merged.diffSummaryLogPath].filter(Boolean);
  merged.artifactsComplete = artifacts.length === 3 && artifacts.every(filePath => fs.existsSync(filePath));

  const next = [merged, ...current.filter(item => item?.runId !== runId)].slice(0, 200);
  fs.writeFileSync(indexPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return indexPath;
}

function buildDryDiffSummary(runId, beforePayload, afterPayload, beforeLogPath, afterLogPath) {
  const diff = {
    messageCountChanged: beforePayload.messageCount !== afterPayload.messageCount,
    rolesChanged: JSON.stringify(beforePayload.roles || []) !== JSON.stringify(afterPayload.roles || []),
    recentThreeRolesChanged: JSON.stringify(beforePayload.recentThreeRoles || []) !== JSON.stringify(afterPayload.recentThreeRoles || []),
    toolCallIdsChanged: JSON.stringify(beforePayload.toolCallIds || []) !== JSON.stringify(afterPayload.toolCallIds || []),
    toolNamesChanged: JSON.stringify(beforePayload.toolNames || []) !== JSON.stringify(afterPayload.toolNames || []),
    systemMessageRewrittenChanged: beforePayload.systemMessageRewritten !== afterPayload.systemMessageRewritten,
  };
  const changed = Object.entries(diff).filter(([, value]) => value).map(([key]) => key);
  return {
    schemaVersion: 1,
    runId,
    mode: 'dry-observe-only',
    createdAt: new Date().toISOString(),
    files: {
      before: beforeLogPath,
      after: afterLogPath,
    },
    diff: {
      ...diff,
      summary: changed.length ? `changed: ${changed.join(', ')}` : 'no structural changes detected',
    },
  };
}

const ROADMAP_REPLY_CONTRACT = [
  '',
  '[VioDashboard roadmap protocol]',
  'At the end of every final reply, append a fenced code block exactly in this format:',
  '```vio-roadmap',
  '{',
  '  "title": "Road Map",',
  '  "summary": "Short truthful summary of follow-up work.",',
  '  "items": [',
  '    {',
  '      "id": "task-1",',
  '      "title": "Concrete next action",',
  '      "description": "Useful execution detail for later task deployment.",',
  '      "status": "proposed",',
  '      "priority": "normal",',
  '      "source": "assistant"',
  '    }',
  '  ]',
  '}',
  '```',
  'Rules:',
  '- The vio-roadmap block must be the LAST part of the reply.',
  '- Always emit valid JSON inside the block.',
  '- If there is no meaningful follow-up work, still emit the block with "items": [].',
  '- Keep the human-readable reply body above the block.',
  '- Put real execution detail in each item description; do not leave descriptions empty when work is actionable.',
].join('\n');

function appendRoadmapContract(text = '') {
  const source = String(text || '').trim();
  if (!source) {return ROADMAP_REPLY_CONTRACT.trim();}
  if (/```vio-roadmap\s*[\r\n]/i.test(source)) {return source;}
  if (/\[VioDashboard roadmap protocol\]/i.test(source)) {return source;}
  return `${source}\n${ROADMAP_REPLY_CONTRACT}`;
}

const OPENCLAW_DIST_DIR = '/opt/homebrew/lib/node_modules/openclaw/dist';
let gatewayCallerPromise = null;

function parseExportAlias(source, symbolName) {
  const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`export\\s*\\{[^}]*${escaped}\\s+as\\s+([^,}\\s]+)`, 'm'));
  return match?.[1] || null;
}

async function loadGatewayCaller() {
  if (gatewayCallerPromise) {return gatewayCallerPromise;}
  gatewayCallerPromise = (async () => {
    const candidates = [];
    try {
      const names = fs.readdirSync(OPENCLAW_DIST_DIR);
      for (const name of names) {
        if (/^gateway-rpc-.*\.js$/.test(name)) {candidates.push({ type: 'gateway-rpc', filePath: path.join(OPENCLAW_DIST_DIR, name) });}
      }
      for (const name of names) {
        if (/^auth-profiles-.*\.js$/.test(name) && !/\.runtime-/.test(name)) {candidates.push({ type: 'auth-profiles', filePath: path.join(OPENCLAW_DIST_DIR, name) });}
      }
    } catch (error) {
      throw new Error(`failed to scan OpenClaw dist dir: ${error?.message || String(error)}`, { cause: error });
    }

    for (const candidate of candidates.toSorted((a, b) => a.filePath.localeCompare(b.filePath)).toReversed()) {
      try {
        const source = fs.readFileSync(candidate.filePath, 'utf8');
        const symbolName = candidate.type === 'gateway-rpc' ? 'callGatewayFromCli' : 'callGateway';
        const alias = parseExportAlias(source, symbolName);
        if (!alias) {continue;}
        const mod = await import(pathToFileURL(candidate.filePath).href);
        const fn = mod?.[alias];
        if (typeof fn !== 'function') {continue;}
        console.log('[wrapper] resolved OpenClaw gateway helper', JSON.stringify({ source: path.basename(candidate.filePath), symbolName, alias }));
        if (candidate.type === 'gateway-rpc') {
          return async ({ method, params, timeoutMs = 10000, expectFinal = false }) => await fn(method, {
            url: gatewayUrl,
            token: gatewayToken,
            timeout: timeoutMs,
            expectFinal,
            json: true,
          }, params, { expectFinal, progress: false });
        }
        return async ({ method, params, timeoutMs = 10000, mode = 'cli', clientName = 'cli', expectFinal = false }) => await fn({
          method,
          params,
          url: gatewayUrl,
          token: gatewayToken,
          mode,
          clientName,
          timeoutMs,
          expectFinal,
        });
      } catch (error) {
        console.warn('[wrapper] failed OpenClaw gateway helper candidate', candidate.filePath, error?.message || String(error));
      }
    }

    throw new Error('unable to resolve a compatible OpenClaw gateway helper from dist/');
  })();
  return gatewayCallerPromise;
}

async function gatewayCall(method, params, options = {}) {
  const caller = await loadGatewayCaller();
  return await caller({
    method,
    params,
    mode: options.mode || 'cli',
    clientName: options.clientName || 'cli',
    timeoutMs: options.timeoutMs || 10000,
    expectFinal: options.expectFinal || false,
  });
}

export class GatewayBridge {
  constructor({ onChatEvent, onStatus, onQueuedMood, onDiagnosticEvent }) {
    this.onChatEvent = onChatEvent;
    this.onStatus = onStatus;
    this.onQueuedMood = onQueuedMood;
    this.onDiagnosticEvent = onDiagnosticEvent;
    this.ws = null;
    this.pending = new Map();
    this.connectNonce = null;
    this.connectSent = false;
    this.connectTimer = null;
    this.hello = null;
    this.connected = false;
    this.chatRunId = null;
    this.gatewayRunId = null;
    this.sessionKey = 'agent:assistant:main';
    this.tokenSaverEnabled = true;
    this.tokenSaverRules = {
      phase1Summary: false,
      phase2ToolCompression: true,
    };
    this.tokenSaver = new TokenSaver();
    this.tokenSaver.setRules(this.tokenSaverRules);
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {return;}
    this.ws = new WebSocket(gatewayUrl, {
      headers: {
        Origin: `http://127.0.0.1:${gatewayPort}`,
      },
    });
    this.ws.on('message', raw => this.handleMessage(String(raw)));
    this.ws.on('open', () => {
      console.log('[wrapper] gateway ws open');
      this.queueConnect();
    });
    this.ws.on('close', (code, reason) => {
      console.log('[wrapper] gateway close', code, String(reason));
      this.connected = false;
      this.connectSent = false;
      this.connectNonce = null;
      setTimeout(() => this.connect(), 1200);
    });
    this.ws.on('error', err => {
      console.log('[wrapper] gateway error', err?.message || String(err));
    });
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('gateway not connected'));
        return;
      }
      const id = randomId();
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  queueConnect() {
    this.connectNonce = null;
    this.connectSent = false;
    if (this.connectTimer) {clearTimeout(this.connectTimer);}
    this.connectTimer = setTimeout(() => {
      this.sendConnect().catch(() => {
        this.connectSent = false;
      });
    }, 750);
  }

  async sendConnect() {
    if (this.connectSent || !this.ws || this.ws.readyState !== WebSocket.OPEN) {return;}
    this.connectSent = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'gateway-client',
        version: '0.1.0',
        platform: process.platform,
        mode: 'backend',
        instanceId: randomId(),
      },
      role: 'operator',
      scopes: ['operator.admin', 'operator.approvals', 'operator.pairing', 'operator.read', 'operator.write'],
      caps: ['tool-events'],
      auth: { token: gatewayToken },
      userAgent: 'VioDashboard/0.1.0',
      locale: 'en-US',
    };
    console.log('[wrapper] sending connect');
    const hello = await this.request('connect', params).catch(error => {
      console.log('[wrapper] connect request failed', error?.message || String(error));
      throw error;
    });
    console.log('[wrapper] hello received');
    this.hello = hello;
    this.connected = true;
    const mainSession = hello?.snapshot?.sessionDefaults?.mainSessionKey?.trim();
    if (mainSession) {this.sessionKey = mainSession;}
    this.onStatus?.({ connected: true, sessionKey: this.sessionKey });
  }

  handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'event') {
      if (msg.event === 'connect.challenge') {
        this.connectNonce = msg.payload?.nonce ?? null;
        this.sendConnect().catch(() => {
          this.connectSent = false;
        });
        return;
      }
      if (msg.event === 'diagnostic') {
        const payload = msg.payload;
        if (payload?.type === 'model.usage') {
          this.onDiagnosticEvent?.(payload);
        }
        return;
      }
      if (msg.event === 'chat') {
        const payload = msg.payload;
        if (!payload) {return;}
        const state = payload.state;
        const runId = payload.runId;
        if (runId && this.chatRunId && runId !== this.chatRunId) {
          if (!this.gatewayRunId) {
            this.gatewayRunId = runId;
            console.log('[wrapper] adopting gateway runId', runId, 'for idempotencyKey', this.chatRunId);
          } else if (runId !== this.gatewayRunId) {
            console.log('[wrapper] ignoring unrelated chat event runId', runId, 'expected', this.gatewayRunId, 'idempotencyKey', this.chatRunId);
            return;
          }
        }
        const rawText = parseMessageText(payload.message);
        const text = sanitizeVisibleText(rawText);
        const usage = extractUsage(payload);
        if (state === 'final' || state === 'error' || state === 'aborted') {
          try {
            console.log('[wrapper] chat payload keys:', Object.keys(payload || {}));
            console.log('[wrapper] extracted usage:', usage ? JSON.stringify(usage) : 'null');
          } catch {}
        }
        if (state === 'final' && text && this.tokenSaverEnabled) {this.tokenSaver.ingest('assistant', text);}
        this.onChatEvent?.({ state, runId, text, rawText, payload, usage });
        if (runId && (state === 'final' || state === 'error' || state === 'aborted')) {
          writeRunIndexEntry(runId, {
            mode: 'dry-observe-only',
            status: state,
            errorMessage: payload?.errorMessage || payload?.error?.message || null,
            completedAt: new Date().toISOString(),
          });
          if (state === 'error' || state === 'aborted') {
            console.log('[dashboard] dry-diff next check:', `node /Users/visen24/MAS/openclaw_fork/apps/viodashboard/scripts/check-run-index.mjs ${runId}`);
          }
        }
        if (state === 'final' || state === 'error' || state === 'aborted') {
          this.chatRunId = null;
          this.gatewayRunId = null;
        }
      }
      return;
    }
    if (msg.type === 'res') {
      const pending = this.pending.get(msg.id);
      if (!pending) {return;}
      this.pending.delete(msg.id);
      if (msg.ok) {pending.resolve(msg.payload);}
      else {pending.reject(new Error(msg.error?.message ?? 'request failed'));}
    }
  }

  async fetchSessionUsage() {
    if (!this.connected) {throw new Error('gateway not connected');}
    const res = await gatewayCall('sessions.usage', {
      key: this.sessionKey,
      limit: 1,
    });
    const row = res?.sessions?.[0] ?? null;
    const usage = row?.usage;
    if (!usage || typeof usage !== 'object') {return null;}
    return {
      input: Number(usage.input ?? 0) || 0,
      output: Number(usage.output ?? 0) || 0,
      cacheRead: Number(usage.cacheRead ?? 0) || 0,
      cacheWrite: Number(usage.cacheWrite ?? 0) || 0,
      total: Number(usage.totalTokens ?? 0) || 0,
      model: typeof row?.model === 'string' ? row.model : null,
      provider: typeof row?.modelProvider === 'string' ? row.modelProvider : null,
    };
  }

  async fetchSessionContextSnapshot() {
    if (!this.connected) {throw new Error('gateway not connected');}
    const res = await gatewayCall('sessions.list', {
      includeGlobal: false,
      includeUnknown: false,
      limit: 200,
    });
    const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
    const row = sessions.find(session => session?.key === this.sessionKey) ?? null;
    if (!row) {return null;}
    return {
      key: row.key,
      totalTokens: typeof row?.totalTokens === 'number' ? row.totalTokens : null,
      contextTokens: typeof row?.contextTokens === 'number' ? row.contextTokens : null,
      totalTokensFresh: row?.totalTokensFresh !== false,
      model: typeof row?.model === 'string' ? row.model : null,
      provider: typeof row?.modelProvider === 'string' ? row.modelProvider : null,
    };
  }

  async fetchModelCatalog() {
    if (!this.connected) {throw new Error('gateway not connected');}
    const res = await gatewayCall('models.list', {});
    if (Array.isArray(res?.models)) {return res.models;}
    if (Array.isArray(res)) {return res;}
    return [];
  }

  getTokenSaverSnapshot() {
    if (!this.tokenSaverEnabled) {
      return {
        enabled: false,
        disabled: true,
        reason: 'token-saver module disabled in gateway bridge',
        lastSend: null,
        memory: {
          summary: '',
          turnCount: 0,
          recentTurns: [],
        },
        lastAssistantFinal: null,
        stats: {
          sendCount: 0,
          totalOriginalChars: 0,
          totalOutboundMessageChars: 0,
          totalContextChars: 0,
          totalSavedChars: 0,
          totalNaiveChars: 0,
          totalEffectiveSentChars: 0,
          totalSavedPctWeighted: 0,
          last: null,
          toolEvents: 0,
        },
      };
    }
    return {
      enabled: true,
      disabled: false,
      ...this.tokenSaver.getSnapshot(),
    };
  }

  setTokenSaverConfig(next = {}) {
    if (typeof next.enabled === 'boolean') {this.tokenSaverEnabled = next.enabled;}
    this.tokenSaverRules = {
      ...this.tokenSaverRules,
      ...(typeof next.phase1Summary === 'boolean' ? { phase1Summary: next.phase1Summary } : {}),
      ...(typeof next.phase2ToolCompression === 'boolean' ? { phase2ToolCompression: next.phase2ToolCompression } : {}),
    };
    if (!this.tokenSaver) {this.tokenSaver = new TokenSaver();}
    this.tokenSaver.setRules(this.tokenSaverRules);
    return this.getTokenSaverSnapshot();
  }

  setTokenSaverEnabled(enabled) {
    return this.setTokenSaverConfig({ enabled });
  }

  async sendChat(text) {
    console.log('[wrapper] bridge.sendChat enter', JSON.stringify({ connected: this.connected, textLength: String(text ?? '').length, preview: String(text ?? '').slice(0, 120) }));
    if (!this.connected) {throw new Error('gateway not connected');}
    const idempotencyKey = randomId();
    if (hasRoadmapBlock(text)) {
      console.warn('[wrapper] roadmap block reached sendChat(input); stripping before gateway send.');
    }
    const originalUserText = sanitizeVisibleText(String(text ?? ''));
    if (this.tokenSaverEnabled) {this.tokenSaver.ingest('user', originalUserText);}
    const roadmapInstruction = 'At the end of your reply, include the required roadmap block only in the assistant output. Never repeat or quote the protocol instructions themselves.';
    const phaseOnePrompt = this.tokenSaverEnabled
      ? buildPhaseOneCompressedPrompt(this.getTokenSaverSnapshot(), originalUserText, roadmapInstruction)
      : roadmapInstruction;
    const extraSystemPrompt = appendRoadmapContract(phaseOnePrompt);
    const contextEnvelope = extraSystemPrompt;
    const sendStats = this.tokenSaverEnabled
      ? this.tokenSaver.recordSend({
          originalUserText,
          outboundMessage: originalUserText,
          contextEnvelope,
          roadmapInstruction,
        })
      : {
          disabled: true,
          originalChars: originalUserText.length,
          outboundMessageChars: originalUserText.length,
          contextChars: extraSystemPrompt.length,
          effectiveSentChars: originalUserText.length + extraSystemPrompt.length,
          naiveChars: originalUserText.length + extraSystemPrompt.length,
          savedChars: 0,
        };
    const beforePayload = {
      schemaVersion: 1,
      runId: idempotencyKey,
      mode: 'dry-observe-only',
      phase: 'before',
      createdAt: new Date().toISOString(),
      enabled: this.tokenSaverEnabled,
      rules: this.tokenSaverRules,
      messageCount: this.tokenSaverEnabled ? this.tokenSaver.turns.length : 0,
      roles: this.tokenSaverEnabled ? this.tokenSaver.turns.map(turn => turn.role) : [],
      recentThreeRoles: this.tokenSaverEnabled ? this.tokenSaver.turns.slice(-3).map(turn => turn.role) : [],
      toolCallIds: [],
      toolNames: this.tokenSaverEnabled ? this.tokenSaver.turns.filter(turn => turn.role === 'tool').slice(-6).map(turn => String(turn.text || '').split('\n')[0]).filter(Boolean) : [],
      systemMessageRewritten: false,
      userPayload: summarizeTokenSaverPayload(originalUserText),
      contextEnvelope: summarizeTokenSaverPayload(contextEnvelope),
      stats: sendStats,
    };
    const simulatedView = simulateTokenSaverView(this.getTokenSaverSnapshot(), originalUserText, roadmapInstruction);
    const afterPayload = {
      schemaVersion: 1,
      runId: idempotencyKey,
      mode: 'dry-observe-only',
      phase: 'after',
      createdAt: new Date().toISOString(),
      enabled: this.tokenSaverEnabled,
      rules: this.tokenSaverRules,
      messageCount: simulatedView.messageCount,
      roles: simulatedView.roles,
      recentThreeRoles: simulatedView.recentThreeRoles,
      toolCallIds: simulatedView.toolCallIds,
      toolNames: simulatedView.toolNames,
      systemMessageRewritten: simulatedView.systemMessageRewritten,
      outboundMessage: summarizeTokenSaverPayload(simulatedView.outboundMessage),
      extraSystemPrompt: summarizeTokenSaverPayload(simulatedView.extraSystemPrompt),
      stats: sendStats,
    };
    const beforeLogPath = writeTokenSaverDebugLog(idempotencyKey, 'before', beforePayload);
    const afterLogPath = writeTokenSaverDebugLog(idempotencyKey, 'after', afterPayload);
    const diffSummary = buildDryDiffSummary(idempotencyKey, beforePayload, afterPayload, beforeLogPath, afterLogPath);
    const diffSummaryLogPath = writeTokenSaverDebugLog(idempotencyKey, 'diff-summary', diffSummary);
    const runIndexPath = writeRunIndexEntry(idempotencyKey, {
      mode: 'dry-observe-only',
      beforeLogPath,
      afterLogPath,
      diffSummaryLogPath,
      status: 'sent',
    });
    this.chatRunId = idempotencyKey;
    this.gatewayRunId = null;
    const sidecarResult = await onUserPrompt().catch(error => {
      console.log('[wrapper] sidecar task-start failed', error?.message || String(error));
      return null;
    });
    this.onQueuedMood?.(idempotencyKey, sidecarResult);
    console.log(`[wrapper] token-saver ${this.tokenSaverEnabled ? 'enabled' : 'disabled'} stats`, JSON.stringify({
      ...sendStats,
      beforeLogPath,
      afterLogPath,
      diffSummaryLogPath,
      runIndexPath,
      snapshot: this.getTokenSaverSnapshot(),
    }));
    console.log('[wrapper] gatewayCall(chat.send) start', JSON.stringify({ sessionKey: this.sessionKey, idempotencyKey, textLength: originalUserText.length }));
    const chatSendRes = await gatewayCall('chat.send', {
      sessionKey: this.sessionKey,
      message: originalUserText,
      deliver: false,
      idempotencyKey,
    });
    console.log('[wrapper] gatewayCall(chat.send) ok', JSON.stringify(chatSendRes || null));
    return idempotencyKey;
  }

  ingestToolResult(label, text, meta = {}) {
    if (!this.tokenSaverEnabled) {return null;}
    return this.tokenSaver.ingestTool(label, text, meta);
  }
}
