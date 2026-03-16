// Main browser UI for VioDashboard: chat, telemetry, camera controls, and file browser.
const DEFAULT_CLAUDE_CWD = '';
const CLAUDE_TERMINAL_INIT_ERROR = 'Claude terminal failed to initialize; PTY text fallback has been removed.';
const serverConfig = {
  defaultClaudeCwd: '',
  projectRoot: '',
  openclawRepoRoot: '',
  appBaseUrl: '',
};
const statusEl = document.getElementById('status');
const runModeChipEl = document.getElementById('runModeChip');
const moodEl = document.getElementById('mood');
const routingEl = document.getElementById('routing');
const cameraTopbarEl = document.getElementById('cameraTopbar');
const chatEl = document.getElementById('chat');
const formEl = document.getElementById('composer');
const inputEl = document.getElementById('input');
const continueBtnEl = document.getElementById('continueBtn');
const stopBtnEl = document.getElementById('stopBtn');
const stopStatusBadgeEl = document.getElementById('stopStatusBadge');
const wrapperDotEl = document.getElementById('wrapperDot');
const sessionKeyEl = document.getElementById('sessionKey');
const moodMiniEl = document.getElementById('moodMini');
const streamStateEl = document.getElementById('streamState');
const distDetailEl = document.getElementById('distDetail');
const distRebuildBtnEl = document.getElementById('distRebuildBtn');
const distDotEl = document.getElementById('distDot');
const debugLogEl = document.getElementById('debugLog');
const chatFlowValueEl = document.getElementById('chatFlowValue');
const chatFlowDetailEl = document.getElementById('chatFlowDetail');
const bodyLinkValueEl = document.getElementById('bodyLinkValue');
const bodyLinkDetailEl = document.getElementById('bodyLinkDetail');
const lastTokensDetailEl = document.getElementById('lastTokensDetail');
const totalTokensDetailEl = document.getElementById('totalTokensDetail');
const modelWindowDetailEl = document.getElementById('modelWindowDetail');
const gatewayDotEl = document.getElementById('gatewayDot');
const moodRouterDotEl = document.getElementById('moodRouterDot');
const currentMoodDotEl = document.getElementById('currentMoodDot');
const modelWindowDotEl = document.getElementById('modelWindowDot');
const cameraDetailEl = document.getElementById('cameraDetail');
const cameraDotEl = document.getElementById('cameraDot');
const cameraCaptureBtnEl = document.getElementById('cameraCaptureBtn');
const cameraPreviewEl = document.getElementById('cameraPreview');
const cameraVisionLabelEl = document.getElementById('cameraVisionLabel');
const cameraGestureLabelEl = document.getElementById('cameraGestureLabel');
const gestureRuntimeDetailEl = document.getElementById('gestureRuntimeDetail');
const gestureActionDetailEl = document.getElementById('gestureActionDetail');
const gestureDebugDetailEl = document.getElementById('gestureDebugDetail');
const gestureWatcherBtnEl = document.getElementById('gestureWatcherBtn');
const gestureWatcherDotEl = document.getElementById('gestureWatcherDot');
const environmentDetailEl = document.getElementById('environmentDetail');
const environmentDotEl = document.getElementById('environmentDot');
const nightLogicDetailEl = document.getElementById('nightLogicDetail');
const nightLogicDotEl = document.getElementById('nightLogicDot');
const tokenSaverDetailEl = document.getElementById('tokenSaverDetail');
const tokenSaverDotEl = document.getElementById('tokenSaverDot');
const contextDetailEl = document.getElementById('contextDetail');
const contextDotEl = document.getElementById('contextDot');
const contextCompactBtnEl = document.getElementById('contextCompactBtn');
const wrapperRestartBtnEl = document.getElementById('wrapperRestartBtn');
const gatewayRestartBtnEl = document.getElementById('gatewayRestartBtn');
const tokenSaverToggleBtnEl = document.getElementById('tokenSaverToggleBtn');
const tokenSaverPhase1BtnEl = document.getElementById('tokenSaverPhase1Btn');
const tokenSaverPhase2BtnEl = document.getElementById('tokenSaverPhase2Btn');
const fileTreeEl = document.getElementById('fileTree');
const activeFilePathEl = document.getElementById('activeFilePath');
const fileEditorEl = document.getElementById('fileEditor');
const fileBrowserRootEl = document.getElementById('fileBrowserRoot');
const fileBackBtnEl = document.getElementById('fileBackBtn');
const fileForwardBtnEl = document.getElementById('fileForwardBtn');
const fileRefreshBtnEl = document.getElementById('fileRefreshBtn');
const openDirBtnEl = document.getElementById('openDirBtn');
const terminalFormEl = document.getElementById('terminalForm');
const terminalInputEl = document.getElementById('terminalInput');
const terminalOutputEl = document.getElementById('terminalOutput');
const terminalCwdEl = document.getElementById('terminalCwd');
const terminalDetachBtnEl = document.getElementById('terminalDetachBtn');
const terminalTerminateBtnEl = document.getElementById('terminalTerminateBtn');
const consoleTabTerminalEl = document.getElementById('consoleTabTerminal');
const consoleTabClaudeEl = document.getElementById('consoleTabClaude');
const consolePaneTerminalEl = document.getElementById('consolePaneTerminal');
const consolePaneClaudeEl = document.getElementById('consolePaneClaude');
const claudeStatusBadgeEl = document.getElementById('claudeStatusBadge');
const claudeCwdInputEl = document.getElementById('claudeCwdInput');
const claudeStartBtnEl = document.getElementById('claudeStartBtn');
const claudeStopBtnEl = document.getElementById('claudeStopBtn');
const claudeRestartBtnEl = document.getElementById('claudeRestartBtn');
const claudeMetaEl = document.getElementById('claudeMeta');
const claudeTerminalHostEl = document.getElementById('claudeTerminalHost');
const claudeOutputEl = document.getElementById('claudeOutput');
const claudeAutoScrollEl = document.getElementById('claudeAutoScroll');
const claudeErrorEl = document.getElementById('claudeError');
const claudeComposerFormEl = document.getElementById('claudeComposer');
const claudeComposerInputEl = document.getElementById('claudeComposerInput');
const claudeComposerSendBtnEl = document.getElementById('claudeComposerSendBtn');
const claudeComposerStatusEl = document.getElementById('claudeComposerStatus');
const fileSaveBtnEl = document.getElementById('fileSaveBtn');
const fileUndoBtnEl = document.getElementById('fileUndoBtn');
const fileHighlightEl = document.getElementById('fileHighlight');
const fileModeBadgeEl = document.getElementById('fileModeBadge');
const workspaceSplitEl = document.getElementById('workspaceSplit');
const editorStackEl = document.getElementById('editorStack');
const cameraFoldEl = document.getElementById('cameraFold');
const gestureFoldEl = document.getElementById('gestureFold');
const safeEditSummaryEl = document.getElementById('safeEditSummary');
const safeEditTxnDetailEl = document.getElementById('safeEditTxnDetail');
const safeEditSmokeDetailEl = document.getElementById('safeEditSmokeDetail');
const safeEditDotEl = document.getElementById('safeEditDot');
let lastSafeEditState = null;

const LAST_REPLY_ROADMAP_KEY = 'vio-wrapper-last-reply-roadmap-v1';
const STRUCTURED_ROADMAP_KEY = 'vio-wrapper-roadmap-v2';
const LAST_ASSISTANT_REPLY_KEY = 'vio-wrapper-last-assistant-reply-v1';

let ws;
let streamingEl = null;
let streamingRunId = null;
const renderedFinalRunIds = new Set();
let activeRunId = null;
let activeRunState = 'idle';
const abortedRunIds = new Set();
let stopRequestedAt = null;
let lastStreamEventAt = 0;
const taskRegistry = new Map();
let latestWrapperRuntime = null;
let lastVisitedDirs = [];
let currentDir = '.';
let currentFilePath = null;
let currentFileOriginal = '';
let terminalSessionId = 'default';
const UI_PREFS_KEY = 'vio-wrapper-ui-prefs-v2';

const consoleTabs = {
  active: 'claude',
};

const runModeState = {
  mode: 'source',
  switching: false,
};

function getDefaultClaudeCwd() {
  return serverConfig.defaultClaudeCwd || serverConfig.openclawRepoRoot || serverConfig.projectRoot || DEFAULT_CLAUDE_CWD || '.';
}

const claude = {
  sessionId: 'claude-default',
  cwd: getDefaultClaudeCwd(),
  status: 'idle',
  running: false,
  started: false,
  exited: false,
  exitCode: null,
  output: '',
  loading: false,
  polling: false,
  pollTimer: null,
  pollIntervalMs: 5000,
  outputTruncated: false,
  autoScroll: true,
  lastOutputLength: 0,
  renderedLength: 0,
  error: '',
  focused: false,
  term: null,
  fitAddon: null,
  terminalReady: false,
  suppressInput: false,
  inputBuffer: '',
  inputFlushTimer: null,
  inputFlushDelayMs: 16,
  composerDraft: '',
  composerSending: false,
  composerStatus: 'Enter 发送 · Shift+Enter 换行',
  composerStatusTone: 'hint',
};

function renderRunModeChip() {
  if (!runModeChipEl) {return;}
  runModeChipEl.textContent = runModeState.switching ? `mode: ${runModeState.mode} → switching…` : `mode: ${runModeState.mode}`;
  runModeChipEl.disabled = !!runModeState.switching;
  runModeChipEl.dataset.mode = runModeState.mode;
  runModeChipEl.classList.remove('state-idle', 'state-thinking');
  runModeChipEl.classList.add(runModeState.switching ? 'state-thinking' : 'state-idle');
}

async function fetchRunMode() {
  const res = await fetch('/api/run-mode', { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok) {throw new Error(data?.error || 'run mode fetch failed');}
  runModeState.mode = data.mode || 'source';
  runModeState.switching = false;
  renderRunModeChip();
  return data;
}

async function toggleRunMode() {
  if (runModeState.switching) {return;}
  const nextMode = runModeState.mode === 'runtime' ? 'source' : 'runtime';
  runModeState.switching = true;
  renderRunModeChip();
  try {
    await fetch('/api/run-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: nextMode }),
    });
  } catch {}

  const startedAt = Date.now();
  const tryPoll = async () => {
    try {
      const data = await fetchRunMode();
      if (data.mode === nextMode) {
        location.reload();
        return;
      }
    } catch {}
    if (Date.now() - startedAt < 20000) {window.setTimeout(tryPoll, 1000);}
    else {
      runModeState.switching = false;
      renderRunModeChip();
    }
  };
  window.setTimeout(tryPoll, 1200);
}

function addDebugLine(text, tone = 'cyan') {
  if (!debugLogEl) {return;}
  const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const el = document.createElement('div');
  el.className = `log-line ${tone}`.trim();
  el.innerHTML = `<span class="log-bracket">[</span><span class="log-time">${stamp}</span><span class="log-bracket">]</span> <span class="log-text">${text.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</span>`;
  debugLogEl.prepend(el);
  while (debugLogEl.children.length > 12) {debugLogEl.removeChild(debugLogEl.lastElementChild);}
}

function formatCompactTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {return 'n/a';}
  if (n >= 1_000_000) {return `${(n / 1_000_000).toFixed(2)}M`;}
  if (n >= 10_000) {return `${Math.round(n / 1000)}k`;}
  if (n >= 1000) {return `${(n / 1000).toFixed(1)}k`;}
  return String(Math.round(n));
}

function formatContextSource(label, data, { staleLabel = false } = {}) {
  if (!data) {return `${label}: n/a`;}
  const used = Number.isFinite(Number(data.used)) ? Number(data.used) : null;
  const limit = Number.isFinite(Number(data.limit)) ? Number(data.limit) : null;
  const pct = Number.isFinite(Number(data.pct)) ? Number(data.pct) : null;
  if (used == null || limit == null || limit <= 0) {return `${label}: n/a`;}
  const stale = staleLabel && data.fresh === false ? ' stale' : '';
  const pctLabel = pct != null ? ` (${pct.toFixed(1)}%)` : '';
  return `${label}: ${formatCompactTokens(used)} / ${formatCompactTokens(limit)}${pctLabel}${stale}`;
}

function renderContextTelemetry(msg = {}) {
  if (!contextDetailEl) {return;}
  const snapshot = msg.contextSnapshot || null;
  const diagnostic = msg.diagnosticContext || null;
  contextDetailEl.textContent = [
    formatContextSource('sessions.list', snapshot, { staleLabel: true }),
    formatContextSource('diag', diagnostic),
  ].join(' · ');

  const usedCandidates = [snapshot?.used, snapshot?.totalTokens, snapshot?.contextTokens, diagnostic?.used, diagnostic?.totalTokens, diagnostic?.contextTokens]
    .map(value => Number(value))
    .filter(value => Number.isFinite(value) && value >= 0);
  const worstUsed = usedCandidates.length ? Math.max(...usedCandidates) : null;
  const dotState = worstUsed == null ? 'safe' : worstUsed > 200_000 ? 'alert' : worstUsed >= 100_000 ? 'mid' : 'safe';
  applyDotState(contextDotEl, 'window', dotState);
}

function registerChatRun(runId) {
  if (!runId) {return;}
  taskRegistry.set(runId, {
    taskId: runId,
    kind: 'chat-run',
    status: 'running',
    backendHandle: runId,
    visibleInUi: true,
    canDetach: false,
    canTerminate: false,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function updateChatRunStatus(runId, status) {
  const task = taskRegistry.get(runId);
  if (!task) {return;}
  task.status = status;
  task.updatedAt = Date.now();
}

function registerExecTask(taskId, command) {
  if (!taskId) {return;}
  taskRegistry.set(taskId, {
    taskId,
    kind: 'exec',
    status: 'running',
    backendHandle: terminalSessionId,
    command,
    visibleInUi: true,
    canDetach: true,
    canTerminate: true,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function updateExecTaskStatus(taskId, status, patch = {}) {
  const task = taskRegistry.get(taskId);
  if (!task) {return;}
  task.status = status;
  Object.assign(task, patch);
  task.updatedAt = Date.now();
}

function findLatestExecTask(status = 'running') {
  const items = [...taskRegistry.values()].filter(task => task.kind === 'exec' && (!status || task.status === status));
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return items[0] || null;
}

function syncTerminalTaskButtons() {
  const runningTask = findLatestExecTask('running');
  const terminableTask = findLatestExecTask('running') || findLatestExecTask('detached');
  if (terminalDetachBtnEl) {terminalDetachBtnEl.disabled = !runningTask;}
  if (terminalTerminateBtnEl) {terminalTerminateBtnEl.disabled = !terminableTask;}
}

function allocExecTaskId() {
  return `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function syncStopButton() {
  if (stopBtnEl) {
    stopBtnEl.hidden = !(activeRunId && activeRunState === 'streaming');
    stopBtnEl.textContent = activeRunState === 'aborting' ? 'Stopping...' : 'Stop';
    stopBtnEl.disabled = activeRunState === 'aborting';
  }
  if (stopStatusBadgeEl) {
    const showStopped = activeRunState === 'aborted';
    stopStatusBadgeEl.hidden = !showStopped;
    stopStatusBadgeEl.textContent = showStopped ? 'Stopped' : 'Stopped';
  }
}

function resetStoppedUiForNewRun() {
  streamingEl = null;
  streamingRunId = null;
  lastStreamEventAt = 0;
  if (activeRunState === 'aborted' || activeRunState === 'final' || activeRunState === 'idle') {
    activeRunState = 'idle';
  }
  syncStopButton();
  syncContinueButton();
}

function forceFinalizeFrontState(reason = 'unknown') {
  addDebugLine(`Force final state cleanup (${reason}) · run ${String(activeRunId || '').slice(0, 8)}`, 'pink');
  activeRunState = 'final';
  activeRunId = null;
  streamingEl = null;
  streamingRunId = null;
  lastStreamEventAt = 0;
  syncStopButton();
  syncContinueButton();
}

function ignoreAbortedRunEvent(event) {
  if (event?.runId && abortedRunIds.has(event.runId)) {
    addDebugLine(`Ignored post-abort event for run ${String(event.runId).slice(0, 8)}`, 'pink');
    return true;
  }
  return false;
}

function applyChatEventToActiveRun(event) {
  if (event.state === 'delta') {
    lastStreamEventAt = Date.now();
    if (event.runId && (!activeRunId || activeRunId !== event.runId)) {
      resetStoppedUiForNewRun();
      activeRunId = event.runId;
      activeRunState = 'streaming';
      registerChatRun(event.runId);
      syncStopButton();
    }
    try {
      setMood('streaming', 'Assistant is streaming live.');
    } catch (error) {
      addDebugLine(`chat delta setMood failed: ${error?.message || error}`, 'pink');
    }
    try {
      const target = ensureStreamingMessageEl(event.runId || activeRunId || null, event.text || '');
      target.textContent = event.text || target.textContent;
    } catch (error) {
      addDebugLine(`chat delta render failed: ${error?.message || error}`, 'pink');
    }
  } else if (event.state === 'final') {
    lastStreamEventAt = Date.now();
    addDebugLine(`Final event run check: active=${String(activeRunId || '').slice(0, 8)} event=${String(event.runId || '').slice(0, 8)}`, 'cyan');
    const finalText = stripRoadmapBlockForDisplay(event.text || '');
    if (!String(finalText || '').trim()) {
      addDebugLine('Ignored empty final event.', 'pink');
      return;
    }
    if (event.runId && renderedFinalRunIds.has(event.runId)) {
      addDebugLine(`Ignored duplicate final for run ${String(event.runId).slice(0, 8)}.`, 'pink');
      return;
    }
    if (event.runId) {
      renderedFinalRunIds.add(event.runId);
      if (renderedFinalRunIds.size > 200) {renderedFinalRunIds.clear();}
    }
    try {
      finalizeStreamingMessage(event.runId || activeRunId || null, finalText);
    } catch (error) {
      addDebugLine(`chat final render failed: ${error?.message || error}`, 'pink');
    }
    try {
      persistLatestAssistantReply(finalText, { runId: event.runId, aborted: false });
      addDebugLine(`Latest reply updated for run ${String(event.runId || '').slice(0, 8)}`, 'cyan');
    } catch (error) {
      addDebugLine(`chat final persist failed: ${error?.message || error}`, 'pink');
    }
    if (event.runId) {updateChatRunStatus(event.runId, 'completed');}
    if (!activeRunId || !event.runId || event.runId === activeRunId) {
      forceFinalizeFrontState('final-event');
    } else {
      addDebugLine(`Final run mismatch: active=${String(activeRunId).slice(0, 8)} event=${String(event.runId).slice(0, 8)}`, 'pink');
      forceFinalizeFrontState('final-run-mismatch');
    }
    addDebugLine(`Final reply received (${finalText.length || 0} chars).`, 'cyan');
  } else if (event.state === 'error') {
    try {
      addMessage('assistant', `Chat error: ${event.payload?.errorMessage || 'unknown error'}`);
    } catch (error) {
      addDebugLine(`chat error render failed: ${error?.message || error}`, 'pink');
    }
    if (event.runId) {updateChatRunStatus(event.runId, 'failed');}
    activeRunState = 'final';
    activeRunId = null;
    streamingEl = null;
    streamingRunId = null;
    syncStopButton();
    syncContinueButton();
    addDebugLine(`Chat error: ${event.payload?.errorMessage || 'unknown error'}`, 'pink');
  } else if (event.state === 'aborted') {
    try {
      addMessage('assistant', '(aborted)');
    } catch (error) {
      addDebugLine(`chat aborted render failed: ${error?.message || error}`, 'pink');
    }
    if (event.runId) {updateChatRunStatus(event.runId, 'aborted');}
    activeRunState = 'aborted';
    activeRunId = null;
    streamingEl = null;
    streamingRunId = null;
    markLatestAssistantReplyAborted(event.runId || null);
    syncStopButton();
    syncContinueButton();
    addDebugLine('Chat run aborted.', 'pink');
  }
}

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}'); } catch { return {}; }
}
function savePrefs(prefs) { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs)); }

function bindFoldPersistence(detailsEl, prefKey, defaultOpen = false) {
  if (!detailsEl) {return;}
  const prefs = loadPrefs();
  const value = prefs[prefKey];
  detailsEl.open = typeof value === 'boolean' ? value : defaultOpen;
  detailsEl.addEventListener('toggle', () => {
    const nextPrefs = loadPrefs();
    nextPrefs[prefKey] = !!detailsEl.open;
    savePrefs(nextPrefs);
  });
}

function applyLayoutPrefs() {
  const prefs = loadPrefs();
  const root = document.documentElement;
  if (prefs.sidebarWidth) {root.style.setProperty('--sidebar-w', `${prefs.sidebarWidth}px`);}
  if (prefs.rightbarWidth != null) {root.style.setProperty('--rightbar-w', `${prefs.rightbarWidth}px`);}
  if (prefs.workspaceLeft) {root.style.setProperty('--workspace-left', `${prefs.workspaceLeft}fr`);}
  if (prefs.workspaceRight) {root.style.setProperty('--workspace-right', `${prefs.workspaceRight}fr`);}
  if (prefs.editorTop) {root.style.setProperty('--editor-top', `${prefs.editorTop}fr`);}
  if (prefs.terminalBottom) {root.style.setProperty('--terminal-bottom', `${prefs.terminalBottom}fr`);}
}

function setupResizers() {
  const root = document.documentElement;
  document.querySelectorAll('.resizer').forEach(handle => {
    handle.addEventListener('pointerdown', event => {
      event.preventDefault();
      const kind = handle.dataset.resize;
      const startX = event.clientX;
      const startSidebar = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-w')) || 260;
      const startRight = parseFloat(getComputedStyle(root).getPropertyValue('--rightbar-w')) || 320;
      const startWorkspaceLeft = parseFloat(getComputedStyle(root).getPropertyValue('--workspace-left')) || 1.15;
      const startWorkspaceRight = parseFloat(getComputedStyle(root).getPropertyValue('--workspace-right')) || 1;
      const startEditorTop = parseFloat(getComputedStyle(root).getPropertyValue('--editor-top')) || 1.5;
      const startTerminalBottom = parseFloat(getComputedStyle(root).getPropertyValue('--terminal-bottom')) || 1;
      const rect = workspaceSplitEl?.getBoundingClientRect();
      const editorRect = editorStackEl?.getBoundingClientRect();

      const onMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        if (kind === 'sidebar') {
          const next = Math.max(220, Math.min(520, startSidebar + dx));
          root.style.setProperty('--sidebar-w', `${next}px`);
        } else if (kind === 'right') {
          const next = Math.max(260, Math.min(520, startRight - dx));
          root.style.setProperty('--rightbar-w', `${next}px`);
        } else if (kind === 'workspace' && rect) {
          const total = rect.width;
          const leftPx = Math.max(280, Math.min(total - 280, (total * (startWorkspaceLeft / (startWorkspaceLeft + startWorkspaceRight))) + dx));
          const rightPx = total - leftPx;
          root.style.setProperty('--workspace-left', `${(leftPx / total) * 2}fr`);
          root.style.setProperty('--workspace-right', `${(rightPx / total) * 2}fr`);
        } else if (kind === 'editor-terminal' && editorRect) {
          const total = editorRect.height;
          const dy = moveEvent.clientY - event.clientY;
          const topPx = Math.max(220, Math.min(total - 160, (total * (startEditorTop / (startEditorTop + startTerminalBottom))) + dy));
          const bottomPx = total - topPx;
          root.style.setProperty('--editor-top', `${(topPx / total) * 2}fr`);
          root.style.setProperty('--terminal-bottom', `${(bottomPx / total) * 2}fr`);
        }
      };

      const onUp = () => {
        const prefs = loadPrefs();
        prefs.sidebarWidth = parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-w')) || 260;
        prefs.rightbarWidth = parseFloat(getComputedStyle(root).getPropertyValue('--rightbar-w')) || 320;
        prefs.workspaceLeft = parseFloat(getComputedStyle(root).getPropertyValue('--workspace-left')) || 1.15;
        prefs.workspaceRight = parseFloat(getComputedStyle(root).getPropertyValue('--workspace-right')) || 1;
        prefs.editorTop = parseFloat(getComputedStyle(root).getPropertyValue('--editor-top')) || 1.5;
        prefs.terminalBottom = parseFloat(getComputedStyle(root).getPropertyValue('--terminal-bottom')) || 1;
        savePrefs(prefs);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    });
  });
}

function applyStateClass(el, state) {
  if (!el) {return;}
  el.classList.remove('state-idle', 'state-thinking', 'state-streaming', 'state-waiting', 'state-error');
  el.classList.add(`state-${state}`);
}

function applyDotState(el, prefix, state) {
  if (!el) {return;}
  el.className = `dot ${prefix}-${state}`;
}

function resizeComposer() {
  if (!inputEl) {return;}
  inputEl.style.height = 'auto';
  const minHeight = 132;
  const next = Math.max(minHeight, Math.min(inputEl.scrollHeight, window.innerHeight * 0.34));
  inputEl.style.height = `${next}px`;
}

function resizeClaudeComposer() {
  if (!claudeComposerInputEl) {return;}
  claudeComposerInputEl.style.height = 'auto';
  const minHeight = 56;
  const next = Math.max(minHeight, Math.min(claudeComposerInputEl.scrollHeight, window.innerHeight * 0.22));
  claudeComposerInputEl.style.height = `${next}px`;
}

function formatStamp(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function avatarLabel(role) { return role === 'user' ? 'X' : 'V'; }
function avatarImageSrc(role) {
  if (role === 'user') {return '/avatars/Xin.JPEG';}
  if (role === 'assistant') {return '/avatars/vio.png';}
  return '';
}

function hasRoadmapBlock(text = '') {
  return /```vio-roadmap\s*[\r\n]/i.test(String(text || ''));
}

function stripRoadmapBlockForDisplay(text = '') {
  return String(text || '').replace(/\n?```vio-roadmap\s*\n[\s\S]*?\n```\s*$/i, '').trim();
}

function warnRoadmapLeak(path, text = '') {
  if (!hasRoadmapBlock(text)) {return;}
  console.warn(`[wrapper-ui] roadmap block reached ${path}; stripping before conversational reuse.`);
}

function countIndent(line = '') {
  const match = String(line).match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function parseBullet(line = '') {
  const trimmed = String(line).trim();
  const match = trimmed.match(/^[-*•]\s+(.+)$/) || trimmed.match(/^\d+[.)]\s+(.+)$/);
  return match ? match[1].trim() : null;
}

function looksLikeSectionBoundary(line = '') {
  const trimmed = String(line).trim();
  if (!trimmed) {return false;}
  if (trimmed.startsWith('```')) {return true;}
  if (/^#{1,6}\s+/.test(trimmed)) {return true;}
  if (/^[A-Z][A-Z\s/&-]{2,}$/.test(trimmed)) {return true;}
  if (/^(summary|notes?|risks?|questions?|decisions?|context|implementation|progress|status)\s*:?$/i.test(trimmed)) {return true;}
  return false;
}

function extractProposedNextSteps(text = '') {
  const source = String(text || '').replace(/\r/g, '');
  const lines = source.split('\n');
  let headingIndex = lines.findIndex(line => /proposed next steps/i.test(line));
  if (headingIndex === -1) {headingIndex = lines.findIndex(line => /next steps/i.test(line));}
  if (headingIndex === -1) {return [];}

  const steps = [];
  let current = null;
  let sawBody = false;

  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const line = lines[i] || '';
    const trimmed = line.trim();

    if (!trimmed) {
      if (current && sawBody) {current.description = current.description.trim();}
      continue;
    }

    if (looksLikeSectionBoundary(line) && steps.length) {break;}

    const bulletText = parseBullet(line);
    const indent = countIndent(line);

    if (bulletText) {
      if (!current || indent <= current.baseIndent) {
        current = {
          id: `roadmap-item-${steps.length + 1}`,
          title: bulletText,
          description: '',
          status: 'proposed',
          priority: 'normal',
          source: 'assistant',
          baseIndent: indent,
        };
        steps.push(current);
        sawBody = false;
        continue;
      }

      current.description += `${current.description ? '\n' : ''}• ${bulletText}`;
      sawBody = true;
      continue;
    }

    if (!current) {continue;}
    current.description += `${current.description ? '\n' : ''}${trimmed}`;
    sawBody = true;
  }

  return steps.map(({ baseIndent, ...item }) => ({
    ...item,
    description: String(item.description || '').trim(),
  }));
}

function persistLatestReplyRoadmap(text = '') {
  try {
    warnRoadmapLeak('persistLatestReplyRoadmap(input)', text);
    const normalizedText = stripRoadmapBlockForDisplay(text);
    const steps = extractProposedNextSteps(normalizedText);
    const now = new Date().toISOString();
    const legacyPayload = {
      id: `roadmap-${Date.now()}`,
      title: 'Latest proposed next steps',
      summary: 'Parsed from the latest Vio reply only.',
      replyText: normalizedText,
      steps,
      updatedAt: now,
    };
    localStorage.setItem(LAST_REPLY_ROADMAP_KEY, JSON.stringify(legacyPayload));

    const structuredPayload = {
      id: legacyPayload.id,
      title: 'Road Map',
      summary: 'Structured roadmap generated from the latest assistant reply. This is a transitional client-side JSON source until backend roadmap generation is added.',
      sourceType: 'structured-json',
      updatedAt: now,
      items: steps.map((step, index) => ({
        id: step.id || `roadmap-item-${index + 1}`,
        title: step.title,
        description: step.description || '',
        status: step.status || 'proposed',
        priority: step.priority || 'normal',
        source: step.source || 'assistant',
      })),
    };
    localStorage.setItem(STRUCTURED_ROADMAP_KEY, JSON.stringify(structuredPayload));
  } catch {}
}

function setMood(mode, detail = '', runtime = null) {
  if (runtime && typeof runtime === 'object') {latestWrapperRuntime = runtime;}
  const value = mode || runtime?.lightOutput || runtime?.mood || 'idle';
  const state = value === 'thinking' ? 'thinking' : value === 'waiting' ? 'waiting' : value === 'error' ? 'error' : value === 'streaming' ? 'streaming' : 'idle';
  if (moodEl) {moodEl.innerHTML = `<span class="semantic-label">mood:</span> <span class="semantic-value">${value}</span>`;}
  if (moodMiniEl) {moodMiniEl.innerHTML = `<span class="semantic-value state-text-${state}">${value}</span>`;}
  if (streamStateEl) {streamStateEl.innerHTML = `<span class="semantic-value">${value}</span>`;}
  if (moodEl) {applyStateClass(moodEl, state);}
  if (moodMiniEl) {applyStateClass(moodMiniEl, state);}
  if (streamStateEl) {applyStateClass(streamStateEl, state);}
  if (moodRouterDotEl) {applyDotState(moodRouterDotEl, 'mood', state);}
  if (currentMoodDotEl) {applyDotState(currentMoodDotEl, 'mood', state);}
}

function setRouting(summary, detail = '') {
  if (routingEl) {routingEl.innerHTML = `<span class="semantic-label">routing:</span> <span class="semantic-value">${summary || 'n/a'}</span>`;}
}

function routingProxyLabel(mode, phase) {
  if (mode === 'error' || phase === 'error') {return 'error';}
  if (phase === 'queued') {return 'queued';}
  if (phase === 'streaming') {return 'streaming';}
  if (mode === 'waiting') {return 'awaiting user';}
  if (phase === 'aborted') {return 'aborted';}
  if (phase === 'final' && mode === 'idle') {return 'settled';}
  if (phase === 'final') {return `${mode} final`;}
  return mode || 'n/a';
}

function setCameraState(state = 'off', result = 'none', vision = 'none', gesture = 'none') {
  if (cameraDetailEl) {cameraDetailEl.innerHTML = `<span class="semantic-label">state</span> <span class="semantic-value">${state}</span><br><span class="semantic-label">result</span> <span class="semantic-value">${result}</span><br><span class="semantic-label">vision</span> <span class="semantic-value">${vision}</span><br><span class="semantic-label">gesture</span> <span class="semantic-value">${gesture}</span>`;}
  if (cameraTopbarEl) {cameraTopbarEl.innerHTML = `<span class="semantic-label">camera:</span> <span class="semantic-value">${state}</span> <span class="semantic-value">· ${gesture}</span>`;}
  if (cameraDotEl) {applyDotState(cameraDotEl, 'window', state === 'on' ? 'safe' : state === 'busy' ? 'mid' : state === 'error' ? 'danger' : 'safe');}
}

function setGestureRuntime(data = {}) {
  const watcherEnabled = !!data.watcherEnabled;
  const busy = !!data.watcherBusy;
  const provider = data.provider?.label || 'unknown provider';
  const interval = Math.round((data.watcherIntervalMs || 0) / 1000);
  const runtimeText = `${watcherEnabled ? 'watcher on' : 'watcher off'} · ${busy ? 'busy' : 'idle'} · ${interval || '?'}s · ${provider}`;
  const actionText = data.lastResult?.action?.action || data.lastAction || 'none';
  const debugBits = [];
  if (data.lastResult?.sampleCount) {debugBits.push(`samples ${data.lastResult.detectedCount || 0}/${data.lastResult.sampleCount}`);}
  if (data.lastResult?.stable === true) {debugBits.push('stable');}
  if (data.lastResult?.stable === false) {debugBits.push('unstable');}
  if (gestureRuntimeDetailEl) {gestureRuntimeDetailEl.innerHTML = `<span class="semantic-value">${runtimeText}</span>`;}
  if (gestureActionDetailEl) {gestureActionDetailEl.innerHTML = `<span class="semantic-value">${actionText}</span>`;}
  if (gestureDebugDetailEl) {gestureDebugDetailEl.innerHTML = `<span class="semantic-value">${debugBits.join(' · ') || 'no gesture runtime data yet'}</span>`;}
  if (gestureWatcherBtnEl) {
    gestureWatcherBtnEl.textContent = watcherEnabled ? 'watcher on' : 'watcher off';
    gestureWatcherBtnEl.className = `chip ${watcherEnabled ? 'state-thinking' : 'state-idle'}`;
  }
  if (gestureWatcherDotEl) {applyDotState(gestureWatcherDotEl, 'window', busy ? 'mid' : watcherEnabled ? 'safe' : 'danger');}
}

async function setGestureWatcher(enabled) {
  const res = await fetch('/api/gesture/watcher', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, intervalMs: 2500 }),
  });
  const data = await res.json();
  if (!res.ok) {throw new Error(data.error || 'watcher update failed');}
  setGestureRuntime(data.gestureRuntime || {});
}

function setEnvironmentTelemetry(vioBody = {}) {
  const env = vioBody.environment || {};
  const temp = env.temperatureC != null ? `${env.temperatureC}°C` : 'n/a';
  const band = env.lightBand || 'unknown';
  const raw = env.lightLevelRaw != null ? env.lightLevelRaw : 'n/a';
  const quiet = vioBody.quiet_hours_active ? 'quiet hours' : 'day mode';
  const effectiveOutput = vioBody.effective_light_output || latestWrapperRuntime?.lightOutput || vioBody.light_output || 'n/a';
  const runtime = vioBody.wrapper_runtime || latestWrapperRuntime;
  if (runtime) {latestWrapperRuntime = runtime;}

  if (environmentDetailEl) {environmentDetailEl.innerHTML = `<span class="semantic-value">temp ${temp} · light ${band} · raw ${raw}</span>`;}
  if (nightLogicDetailEl) {
    const suffix = runtime?.activeRunCount ? ` · active runs ${runtime.activeRunCount}` : '';
    nightLogicDetailEl.innerHTML = `<span class="semantic-value">${quiet} · output ${effectiveOutput}${suffix}</span>`;
  }
  if (environmentDotEl) {applyDotState(environmentDotEl, 'window', band === 'dark' ? 'danger' : band === 'dim' ? 'mid' : 'safe');}
  if (nightLogicDotEl) {applyDotState(nightLogicDotEl, 'window', effectiveOutput === 'thinking' ? 'safe' : effectiveOutput === 'off' ? 'danger' : vioBody.quiet_hours_active ? 'mid' : 'safe');}
}

async function refreshVioBodyState() {
  try {
    const res = await fetch('/api/vio-body-state');
    const data = await res.json();
    if (!res.ok) {throw new Error(data.error || 'VioBody state unavailable');}
    setEnvironmentTelemetry(data);

    const runtime = data.wrapper_runtime || latestWrapperRuntime || null;
    const effectiveOutput = data.effective_light_output || runtime?.lightOutput || data.light_output || data.current_status || 'idle';
    const detail = `Body state: ${data.current_status || effectiveOutput} · light ${data.light_output || effectiveOutput}`;

    if (runtime && Number(runtime.activeRunCount || 0) === 0) {
      setMood(effectiveOutput, detail, runtime);
      setRouting(effectiveOutput === 'idle' ? 'settled' : effectiveOutput, `phase=${runtime.phase || 'idle'} · mode=${effectiveOutput}`);
    }
  } catch {
    if (environmentDetailEl) {environmentDetailEl.innerHTML = '<span class="semantic-value">unavailable</span>';}
    if (nightLogicDetailEl) {nightLogicDetailEl.innerHTML = '<span class="semantic-value">unavailable</span>';}
  }
}

function renderTokenSaverState(data = {}) {
  const enabled = data?.enabled === true || data?.disabled === false;
  const rules = data?.rules || {};
  const stats = data?.stats || {};
  const last = data?.lastSend?.stats || stats?.last || null;
  const totalSaved = Number(stats?.totalSavedChars || 0) || 0;
  const sendCount = Number(stats?.sendCount || 0) || 0;
  const savedLast = Number(last?.savedChars || 0) || 0;
  const contextChars = Number(last?.contextChars || 0) || 0;
  const savedPct = Number(last?.savedPct || 0) || 0;
  const totalSavedPct = Number(stats?.totalSavedPctWeighted || 0) || 0;
  const detail = enabled
    ? (sendCount
        ? `on · last ${savedLast} chars (${savedPct}%) · total ${totalSaved} (${totalSavedPct}%) · sends ${sendCount} · ctx ${contextChars}`
        : 'on · no savings recorded yet')
    : 'off · pass-through mode';
  if (tokenSaverDetailEl) {tokenSaverDetailEl.innerHTML = `<span class="semantic-value">${detail}</span>`;}
  if (tokenSaverToggleBtnEl) {
    tokenSaverToggleBtnEl.textContent = enabled ? 'on' : 'off';
    tokenSaverToggleBtnEl.className = `chip ${enabled ? 'state-thinking' : 'state-idle'} token-saver-toggle`;
    tokenSaverToggleBtnEl.dataset.enabled = enabled ? 'true' : 'false';
  }
  if (tokenSaverPhase1BtnEl) {
    const on = rules.phase1Summary !== false;
    tokenSaverPhase1BtnEl.textContent = `L1 ${on ? 'on' : 'off'}`;
    tokenSaverPhase1BtnEl.className = `chip ${on ? 'state-thinking' : 'state-idle'} token-saver-toggle`;
    tokenSaverPhase1BtnEl.dataset.enabled = on ? 'true' : 'false';
  }
  if (tokenSaverPhase2BtnEl) {
    const on = rules.phase2ToolCompression === true;
    tokenSaverPhase2BtnEl.textContent = `L2 ${on ? 'on' : 'off'}`;
    tokenSaverPhase2BtnEl.className = `chip ${on ? 'state-thinking' : 'state-idle'} token-saver-toggle`;
    tokenSaverPhase2BtnEl.dataset.enabled = on ? 'true' : 'false';
  }
  if (tokenSaverDotEl) {applyDotState(tokenSaverDotEl, 'window', enabled ? (totalSaved > 0 || savedLast > 0 ? 'safe' : sendCount > 0 ? 'mid' : 'safe') : 'danger');}
}

async function refreshTokenSaverStats() {
  try {
    const res = await fetch('/api/coms/token-saver');
    const data = await res.json();
    if (!res.ok) {throw new Error(data.error || 'token saver stats unavailable');}
    renderTokenSaverState(data?.tokenSaver || {});
  } catch (error) {
    if (tokenSaverDetailEl) {tokenSaverDetailEl.innerHTML = `<span class="semantic-value">${error.message || error}</span>`;}
    if (tokenSaverDotEl) {applyDotState(tokenSaverDotEl, 'window', 'danger');}
  }
}

function formatDistBuiltAt(value) {
  if (!value) {return 'unknown';}
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {return String(value);}
  return d.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function refreshDistInfo() {
  try {
    const res = await fetch('/api/dist-info');
    const data = await res.json();
    if (!res.ok) {throw new Error(data?.error || 'dist info unavailable');}
    const info = data?.info || null;
    if (distDetailEl) {
      distDetailEl.innerHTML = info
        ? `<span class="semantic-value">built ${formatDistBuiltAt(info.builtAt)} · ${info.version || 'unknown'} · ${String(info.commit || '').slice(0, 8) || 'no-commit'}</span>`
        : '<span class="semantic-value">build info unavailable</span>';
    }
    if (distDotEl) {applyDotState(distDotEl, 'link', info?.builtAt ? 'online' : 'offline');}
  } catch (error) {
    if (distDetailEl) {distDetailEl.innerHTML = `<span class="semantic-value">${error?.message || error}</span>`;}
    if (distDotEl) {applyDotState(distDotEl, 'link', 'offline');}
  }
}

async function rebuildDist() {
  if (!distRebuildBtnEl || distRebuildBtnEl.disabled) {return;}
  const prevText = distRebuildBtnEl.textContent;
  distRebuildBtnEl.disabled = true;
  distRebuildBtnEl.textContent = 'Rebuilding…';
  addDebugLine('Dist rebuild requested.', 'cyan');
  try {
    const res = await fetch('/api/dist-rebuild', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {throw new Error(data?.error || 'Failed to rebuild dist');}
    setTimeout(() => {
      refreshDistInfo().catch(() => {});
      distRebuildBtnEl.disabled = false;
      distRebuildBtnEl.textContent = prevText || 'Rebuild';
    }, 6000);
  } catch (error) {
    addDebugLine(`Dist rebuild failed: ${error?.message || error}`, 'pink');
    distRebuildBtnEl.disabled = false;
    distRebuildBtnEl.textContent = prevText || 'Rebuild';
  }
}

async function updateTokenSaverConfig(patch = {}) {
  const res = await fetch('/api/coms/token-saver', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok) {throw new Error(data.error || 'token saver toggle failed');}
  renderTokenSaverState(data?.tokenSaver || {});
}

async function setTokenSaverEnabled(enabled) {
  return updateTokenSaverConfig({ enabled });
}

async function refreshCameraTelemetry() {
  try {
    const res = await fetch('/api/camera');
    const data = await res.json();
    if (!res.ok) {throw new Error(data.error || 'camera telemetry failed');}
    const state = data.enabled ? 'on' : 'off';
    const result = data.latestCapture ? `${data.latestCapture.name} · ${Math.round((data.latestCapture.size || 0) / 1024)} KB` : 'no captures yet';
    const stable = data.vision?.stable;
    const sampleCount = data.vision?.sampleCount;
    const detectedCount = data.vision?.detectedCount;
    const visionBase = data.vision?.label || 'none';
    const vision = sampleCount ? `${visionBase} · ${detectedCount ?? 0}/${sampleCount}` : visionBase;
    const gestureBase = data.vision?.gesture || 'none';
    const gesture = stable === false ? `${gestureBase} · unstable` : stable === true ? `${gestureBase} · stable` : gestureBase;
    setCameraState(state, result, vision, gesture);
    if (cameraPreviewEl) {
      if (data.latestCapture?.url) {
        cameraPreviewEl.src = `${data.latestCapture.url}?t=${Date.now()}`;
        cameraPreviewEl.style.display = 'block';
      } else {
        cameraPreviewEl.removeAttribute('src');
        cameraPreviewEl.style.display = 'none';
      }
    }
    if (cameraVisionLabelEl) {cameraVisionLabelEl.textContent = data.vision?.label || 'none';}
    if (cameraGestureLabelEl) {cameraGestureLabelEl.textContent = data.vision?.gesture || 'none';}
    setGestureRuntime(data.gestureRuntime || {});
  } catch {
    setCameraState('error', 'telemetry unavailable', 'unknown', 'unknown');
  }
}

async function runCameraCapture() {
  if (cameraCaptureBtnEl) {
    cameraCaptureBtnEl.disabled = true;
    cameraCaptureBtnEl.textContent = 'capturing';
  }
  setCameraState('busy', 'warmup capture running', 'capturing', 'pending');
  try {
    const captureRes = await fetch('/api/camera/capture-step', { method: 'POST' });
    const captureData = await captureRes.json();
    if (!captureRes.ok) {throw new Error(captureData.error || 'capture failed');}
    await refreshCameraTelemetry();
    addDebugLine(`Camera capture ok: ${captureData.capture?.path || 'unknown'}`, 'cyan');
  } catch (error) {
    setCameraState('error', error.message || 'capture failed', 'error', 'error');
    addDebugLine(`Camera capture failed: ${error.message || error}`, 'pink');
  } finally {
    if (cameraCaptureBtnEl) {
      cameraCaptureBtnEl.disabled = false;
      cameraCaptureBtnEl.textContent = 'capture';
    }
  }
}

function appendTerminalOutput(text, tone = 'cyan') {
  if (!terminalOutputEl) {return;}
  const stamp = formatStamp();
  const block = document.createElement('div');
  block.className = `terminal-block ${tone}`;
  block.textContent = `[${stamp}] ${text}`;
  terminalOutputEl.appendChild(block);
  terminalOutputEl.scrollTop = terminalOutputEl.scrollHeight;
}

function summarizeSafeEditResult(safeEdit) {
  if (!safeEdit) {return 'direct write';}
  const smokeOk = safeEdit?.checks?.smoke?.ok;
  const smokeLabel = smokeOk === true ? 'smoke ok' : smokeOk === false ? 'smoke warn' : 'smoke n/a';
  return `${safeEdit.strategy || 'safe-edit'} · ${safeEdit.status || 'unknown'} · ${smokeLabel}`;
}

function renderSafeEditState(data = {}) {
  const transactions = Array.isArray(data?.transactions) ? data.transactions : [];
  const latest = transactions[0] || null;
  const smoke = latest?.checks?.smoke || data?.smoke || null;
  const smokeChecks = Array.isArray(smoke?.checks) ? smoke.checks : [];
  const smokeSummary = smokeChecks.length
    ? smokeChecks.map(item => `${item.name}:${item.ok ? 'ok' : 'warn'}`).join(' · ')
    : (smoke?.ok === true ? 'ok' : smoke?.ok === false ? 'warn' : 'n/a');
  if (safeEditSummaryEl) {safeEditSummaryEl.innerHTML = `<span class="semantic-value">${latest ? `${latest.strategy || 'safe-edit'} · ${latest.status || 'unknown'}` : 'no transaction yet'}</span>`;}
  if (safeEditTxnDetailEl) {safeEditTxnDetailEl.innerHTML = `<span class="semantic-value">${latest ? `${String(latest.id || '').slice(0, 16)} · phases b:${latest.phases?.backup || '-'} s:${latest.phases?.stage || '-'} v:${latest.phases?.validate || '-'} c:${latest.phases?.commit || '-'} f:${latest.phases?.finalize || '-'}` : 'n/a'}</span>`;}
  if (safeEditSmokeDetailEl) {safeEditSmokeDetailEl.innerHTML = `<span class="semantic-value">${smokeSummary}</span>`;}
  if (safeEditDotEl) {applyDotState(safeEditDotEl, 'window', latest?.failed ? 'danger' : smoke?.ok === false ? 'mid' : latest ? 'safe' : 'mid');}
}

async function refreshSafeEditState() {
  try {
    const res = await fetch('/api/safe-edit/state');
    const data = await res.json();
    if (!res.ok) {throw new Error(data.error || 'safe-edit state unavailable');}
    lastSafeEditState = data;
    renderSafeEditState(data);
  } catch (error) {
    addDebugLine(`Safe-edit state refresh failed: ${error.message || error}`, 'pink');
    if (safeEditSummaryEl) {safeEditSummaryEl.innerHTML = `<span class="semantic-value">unavailable</span>`;}
    if (safeEditTxnDetailEl) {safeEditTxnDetailEl.innerHTML = `<span class="semantic-value">${error.message || error}</span>`;}
    if (safeEditSmokeDetailEl) {safeEditSmokeDetailEl.innerHTML = `<span class="semantic-value">n/a</span>`;}
    if (safeEditDotEl) {applyDotState(safeEditDotEl, 'window', 'danger');}
  }
}

async function openCurrentDirectoryInFinder() {
  const res = await fetch('/api/explorer/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: currentDir || '.' }),
  });
  const data = await res.json();
  if (!res.ok) {throw new Error(data.error || 'open directory failed');}
  appendTerminalOutput(`Opened in Finder: ${data.dir || currentDir}`, 'cyan');
}

async function ensureTerminalSession() {
  const res = await fetch(`/api/terminal/session?cwd=${encodeURIComponent(currentDir || '.')}`);
  const data = await res.json();
  if (!res.ok) {throw new Error(data.error || 'terminal session failed');}
  terminalSessionId = data.sessionId || 'default';
  if (terminalOutputEl) {terminalOutputEl.textContent = data.output || '';}
}

function updateClaudeFocusState() {
  if (!claudeTerminalHostEl) {return;}
  claudeTerminalHostEl.classList.toggle('is-focused', !!claude.focused);
}

async function sendClaudeRawInput(text) {
  if (!text) {return;}
  await fetch('/api/claude/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, cwd: claude.cwd, raw: true }),
  });
}

async function flushClaudeInputBuffer() {
  if (claude.inputFlushTimer) {
    clearTimeout(claude.inputFlushTimer);
    claude.inputFlushTimer = null;
  }
  const payload = claude.inputBuffer;
  if (!payload) {return;}
  claude.inputBuffer = '';
  try {
    await sendClaudeRawInput(payload);
  } catch {}
}

function scheduleClaudeInputFlush() {
  if (claude.inputFlushTimer) {return;}
  claude.inputFlushTimer = window.setTimeout(() => {
    flushClaudeInputBuffer();
  }, claude.inputFlushDelayMs);
}

function shouldSendClaudeInputImmediately(data) {
  if (!data) {return false;}
  if (data === '\r' || data === '\n') {return true;}
  if (data === '\u001b') {return true;}
  if (data.startsWith('\u001b[')) {return true;}
  if (data.startsWith('\u001bO')) {return true;}
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code < 32 && data !== '\u007f') {return true;}
  }
  return false;
}

function ensureClaudeTerminal() {
  if (claude.terminalReady || !claudeTerminalHostEl || !window.Terminal || !window.FitAddon?.FitAddon) {return;}
  claude.term = new window.Terminal({
    convertEol: false,
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 17,
    theme: {
      background: '#0b1020',
      foreground: '#d7f8ff',
      cursor: '#8fffe0',
      selectionBackground: 'rgba(143,255,224,0.18)',
    },
    scrollback: 5000,
  });
  claude.fitAddon = new window.FitAddon.FitAddon();
  claude.term.loadAddon(claude.fitAddon);
  claude.term.open(claudeTerminalHostEl);
  claude.fitAddon.fit();
  claudeTerminalHostEl?.addEventListener('focusin', () => {
    claude.focused = true;
    updateClaudeFocusState();
  });
  claudeTerminalHostEl?.addEventListener('focusout', () => {
    claude.focused = false;
    updateClaudeFocusState();
  });
  claude.term.onData(data => {
    if (!claude.running) {return;}
    if (shouldSendClaudeInputImmediately(data)) {
      flushClaudeInputBuffer().finally(() => {
        sendClaudeRawInput(data).catch(() => {});
      });
      return;
    }
    claude.inputBuffer += data;
    scheduleClaudeInputFlush();
  });
  claude.term.onFocus?.(() => {
    claude.focused = true;
    updateClaudeFocusState();
  });
  claude.term.onBlur?.(() => {
    claude.focused = false;
    updateClaudeFocusState();
  });
  claudeTerminalHostEl?.addEventListener('pointerdown', () => {
    requestAnimationFrame(() => claude.term?.focus());
  });
  claude.terminalReady = true;
}

function syncClaudeTerminalOutput() {
  ensureClaudeTerminal();
  const text = claude.output || '';
  if (!claude.term) {
    claude.error = claude.error || CLAUDE_TERMINAL_INIT_ERROR;
    return;
  }
  const nextChunk = text.slice(claude.renderedLength);
  if (!nextChunk) {return;}
  claude.term.write(nextChunk, () => {
    if (claude.autoScroll) {claude.term.scrollToBottom();}
  });
  claude.renderedLength = text.length;
  claude.lastOutputLength = text.length;
}

function resetClaudeTerminalOutput() {
  ensureClaudeTerminal();
  if (!claude.term) {
    claude.error = claude.error || CLAUDE_TERMINAL_INIT_ERROR;
    claude.renderedLength = 0;
    return;
  }
  claude.term.reset();
  claude.renderedLength = 0;
  if (claude.outputTruncated) {
    const notice = '\x1b[2m[... earlier output not shown — log exceeded 50 KB limit ...]\x1b[0m\r\n';
    claude.term.write(notice);
  }
}

function setClaudeComposerStatus(message, tone = 'hint') {
  claude.composerStatus = message || 'Enter 发送 · Shift+Enter 换行';
  claude.composerStatusTone = tone || 'hint';
  if (claudeComposerStatusEl) {
    claudeComposerStatusEl.textContent = claude.composerStatus;
    claudeComposerStatusEl.dataset.tone = claude.composerStatusTone;
  }
}

function renderClaudeComposer() {
  if (claudeComposerInputEl && document.activeElement !== claudeComposerInputEl) {
    if (claudeComposerInputEl.value !== claude.composerDraft) {claudeComposerInputEl.value = claude.composerDraft;}
  }
  resizeClaudeComposer();
  const trimmed = (claude.composerDraft || '').trim();
  const disabled = claude.loading || claude.composerSending;
  if (claudeComposerInputEl) {claudeComposerInputEl.disabled = disabled;}
  if (claudeComposerSendBtnEl) {
    claudeComposerSendBtnEl.disabled = disabled || !trimmed.length;
    claudeComposerSendBtnEl.textContent = claude.composerSending ? 'Sending…' : 'Send';
  }
  setClaudeComposerStatus(claude.composerStatus, claude.composerStatusTone);
}

async function submitClaudeComposer() {
  const value = String(claude.composerDraft || '').trim();
  if (!value || claude.composerSending || claude.loading) {return;}
  claude.composerSending = true;
  setClaudeComposerStatus('Sending to Claude…', 'busy');
  renderClaudeComposer();
  setConsoleTab('claude');
  addDebugLine(`Claude composer send len=${value.length}`, 'cyan');
  try {
    await flushClaudeInputBuffer();
    const res = await fetch('/api/claude/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: value, cwd: claude.cwd, raw: false }),
    });
    const data = await res.json();
    if (!res.ok) {throw new Error(data?.error || 'Failed to send to Claude');}
    await sendClaudeRawInput('\r');
    applyClaudeStateData(data);
    claude.composerDraft = '';
    if (claudeComposerInputEl) {claudeComposerInputEl.value = '';}
    resizeClaudeComposer();
    renderClaudeComposer();
    addDebugLine('Claude composer send accepted.', 'cyan');
    setClaudeComposerStatus('Sent to Claude. Waiting for PTY output…', 'success');
    window.setTimeout(() => {
      fetchClaudeState().catch(error => {
        addDebugLine(`Claude post-send refresh failed: ${error?.message || error}`, 'pink');
      });
    }, 120);
    window.setTimeout(() => {
      fetchClaudeState().catch(() => {});
    }, 600);
    window.setTimeout(() => {
      if (!claude.composerDraft && !claude.composerSending) {setClaudeComposerStatus('Enter 发送 · Shift+Enter 换行', 'hint');}
    }, 2200);
    claude.term?.focus();
    claudeComposerInputEl?.focus();
  } catch (error) {
    claude.error = error?.message || String(error);
    addDebugLine(`Claude composer send failed: ${claude.error}`, 'pink');
    setClaudeComposerStatus(claude.error || 'Send failed, retry', 'error');
    renderClaudeChrome();
    claudeComposerInputEl?.focus();
  } finally {
    claude.composerSending = false;
    renderClaudeComposer();
  }
}

async function fetchServerConfig() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) {throw new Error(data?.error || 'config fetch failed');}
    Object.assign(serverConfig, data?.config || {});
    claude.cwd = claude.cwd || getDefaultClaudeCwd();
    if (fileBrowserRootEl && serverConfig.projectRoot) {fileBrowserRootEl.textContent = serverConfig.projectRoot;}
  } catch (error) {
    addDebugLine(`config fetch failed: ${error?.message || error}`, 'pink');
  }
}

function renderClaudeChrome() {
  if (claudeStatusBadgeEl) {
    const nextStatus = claude.status || 'idle';
    if (claudeStatusBadgeEl.textContent !== nextStatus) {claudeStatusBadgeEl.textContent = nextStatus;}
    if (claudeStatusBadgeEl.dataset.status !== nextStatus) {claudeStatusBadgeEl.dataset.status = nextStatus;}
  }
  if (claudeCwdInputEl && document.activeElement !== claudeCwdInputEl) {
    const nextCwd = claude.cwd || getDefaultClaudeCwd();
    if (claudeCwdInputEl.value !== nextCwd) {claudeCwdInputEl.value = nextCwd;}
  }
  if (claudeMetaEl) {
    const nextMeta = `<span class="semantic-label">session</span> <span class="semantic-value">${claude.sessionId || 'claude-default'}</span> <span class="semantic-label">· running</span> <span class="semantic-value">${claude.running ? 'yes' : 'no'}</span> <span class="semantic-label">· exit</span> <span class="semantic-value">${claude.exitCode ?? '-'}</span> <span class="semantic-label">· status</span> <span class="semantic-value">${claude.status || 'idle'}</span>`;
    if (claudeMetaEl.innerHTML !== nextMeta) {claudeMetaEl.innerHTML = nextMeta;}
  }
  if (claudeErrorEl) {
    const nextError = claude.error || '';
    if (claudeErrorEl.textContent !== nextError) {claudeErrorEl.textContent = nextError;}
  }
  if (claudeStartBtnEl) {claudeStartBtnEl.disabled = claude.loading || claude.running;}
  if (claudeStopBtnEl) {claudeStopBtnEl.disabled = claude.loading || !claude.running;}
  if (claudeRestartBtnEl) {claudeRestartBtnEl.disabled = claude.loading;}
  if (claudeAutoScrollEl) {claudeAutoScrollEl.checked = !!claude.autoScroll;}
}

function renderClaudePanel() {
  ensureClaudeTerminal();
  if (claudeOutputEl) {claudeOutputEl.hidden = true;}
  if (claudeTerminalHostEl) {claudeTerminalHostEl.hidden = !claude.term;}
  if (!claude.term) {
    claude.error = claude.error || CLAUDE_TERMINAL_INIT_ERROR;
  }
  renderClaudeChrome();
  renderClaudeComposer();
  syncClaudeTerminalOutput();
}

function maybeScrollClaudeOutput() {
  if (!claude.term || !claude.autoScroll) {return;}
  claude.term.scrollToBottom();
}

async function resizeClaudeSession() {
  ensureClaudeTerminal();
  if (!claude.term) {return;}
  if (claude.fitAddon) {claude.fitAddon.fit();}
  const hostWidth = claudeTerminalHostEl?.clientWidth || 0;
  const hostHeight = claudeTerminalHostEl?.clientHeight || 0;
  const cols = claude.term.cols || Math.max(40, Math.floor(hostWidth / 8));
  const rows = claude.term.rows || Math.max(12, Math.floor(hostHeight / 18));
  try {
    await fetch('/api/claude/resize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols, rows }),
    });
  } catch {}
}

function applyClaudeStateData(data) {
  const prevOutput = claude.output || '';
  const prevStatus = claude.status;
  const prevRunning = claude.running;
  const prevExitCode = claude.exitCode;
  const prevSessionId = claude.sessionId;
  claude.sessionId = data.sessionId || 'claude-default';
  claude.cwd = data.cwd || claude.cwd;
  claude.status = data.status || (data.running ? 'running' : 'idle');
  claude.running = !!data.running;
  claude.started = !!data.started;
  claude.exited = !!data.exited;
  claude.exitCode = data.exitCode ?? null;
  claude.outputTruncated = !!data.outputTruncated;
  const nextOutput = data.output || '';
  if (!nextOutput.startsWith(prevOutput)) {resetClaudeTerminalOutput();}
  claude.output = nextOutput;
  claude.error = '';
  const chromeChanged = prevStatus !== claude.status || prevRunning !== claude.running || prevExitCode !== claude.exitCode || prevSessionId !== claude.sessionId;
  if (chromeChanged) {renderClaudeChrome();}
  if (nextOutput !== prevOutput) {syncClaudeTerminalOutput();}
  if (claude.running) {ensureClaudePolling();}
  else {stopClaudePolling();}
}

async function fetchClaudeState() {
  const res = await fetch(`/api/claude/state?cwd=${encodeURIComponent(claude.cwd || getDefaultClaudeCwd())}`, { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok) {throw new Error(data?.error || 'Failed to fetch Claude state');}
  applyClaudeStateData(data);
}

function ensureClaudePolling() {
  if (claude.pollTimer) {return;}
  claude.pollTimer = window.setInterval(async () => {
    if (claude.polling) {return;}
    claude.polling = true;
    try {
      await fetchClaudeState();
    } catch (error) {
      claude.error = error?.message || String(error);
      renderClaudeChrome();
    } finally {
      claude.polling = false;
    }
  }, claude.pollIntervalMs);
}

function stopClaudePolling() {
  if (claude.pollTimer) {
    clearInterval(claude.pollTimer);
    claude.pollTimer = null;
  }
}

async function startClaude() {
  claude.inputBuffer = '';
  if (claude.inputFlushTimer) {
    clearTimeout(claude.inputFlushTimer);
    claude.inputFlushTimer = null;
  }
  claude.loading = true;
  claude.error = '';
  claude.status = 'starting';
  claude.cwd = (claudeCwdInputEl?.value || getDefaultClaudeCwd()).trim() || getDefaultClaudeCwd();
  renderClaudePanel();
  try {
    const res = await fetch('/api/claude/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: claude.cwd }),
    });
    const data = await res.json();
    if (!res.ok) {throw new Error(data?.error || 'Failed to start Claude');}
    applyClaudeStateData(data);
    window.setTimeout(() => fetchClaudeState().catch(() => {}), 250);
  } catch (error) {
    claude.error = error?.message || String(error);
    claude.status = 'error';
  } finally {
    claude.loading = false;
    renderClaudePanel();
    claude.term?.focus();
  }
}

async function stopClaude() {
  flushClaudeInputBuffer().catch(() => {});
  claude.loading = true;
  claude.error = '';
  renderClaudePanel();
  try {
    const res = await fetch('/api/claude/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!res.ok) {throw new Error(data?.error || 'Failed to stop Claude');}
    applyClaudeStateData(data);
  } catch (error) {
    claude.error = error?.message || String(error);
  } finally {
    claude.loading = false;
    renderClaudePanel();
  }
}

async function restartClaude() {
  claude.inputBuffer = '';
  if (claude.inputFlushTimer) {clearTimeout(claude.inputFlushTimer); claude.inputFlushTimer = null;}
  claude.loading = true;
  claude.error = '';
  claude.cwd = (claudeCwdInputEl?.value || getDefaultClaudeCwd()).trim() || getDefaultClaudeCwd();
  renderClaudePanel();
  try {
    const res = await fetch('/api/claude/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: claude.cwd }),
    });
    const data = await res.json();
    if (!res.ok) {throw new Error(data?.error || 'Failed to restart Claude');}
    applyClaudeStateData(data);
  } catch (error) {
    claude.error = error?.message || String(error);
  } finally {
    claude.loading = false;
    renderClaudePanel();
  }
}

async function restartWrapper() {
  if (!wrapperRestartBtnEl || wrapperRestartBtnEl.disabled) {return;}
  const prevText = wrapperRestartBtnEl.textContent;
  wrapperRestartBtnEl.disabled = true;
  wrapperRestartBtnEl.textContent = 'Restarting…';
  addDebugLine('Wrapper restart requested.', 'cyan');
  try {
    const res = await fetch('/api/wrapper/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {throw new Error(data?.error || 'Failed to restart wrapper');}
  } catch (error) {
    addDebugLine(`Wrapper restart failed: ${error?.message || error}`, 'pink');
    wrapperRestartBtnEl.disabled = false;
    wrapperRestartBtnEl.textContent = prevText || 'Restart';
  }
}

async function restartGateway() {
  if (!gatewayRestartBtnEl || gatewayRestartBtnEl.disabled) {return;}
  const prevText = gatewayRestartBtnEl.textContent;
  gatewayRestartBtnEl.disabled = true;
  gatewayRestartBtnEl.textContent = 'Restarting gateway…';
  addDebugLine('Gateway restart requested.', 'cyan');
  try {
    const res = await fetch('/api/gateway/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {throw new Error(data?.error || 'Failed to restart gateway');}
    setTimeout(() => {
      if (gatewayRestartBtnEl) {
        gatewayRestartBtnEl.disabled = false;
        gatewayRestartBtnEl.textContent = prevText || 'Restart';
      }
    }, 5000);
  } catch (error) {
    addDebugLine(`Gateway restart failed: ${error?.message || error}`, 'pink');
    gatewayRestartBtnEl.disabled = false;
    gatewayRestartBtnEl.textContent = prevText || 'Restart';
  }
}

async function compactContext() {
  if (!contextCompactBtnEl || contextCompactBtnEl.disabled) {return;}
  const prevText = contextCompactBtnEl.textContent;
  contextCompactBtnEl.disabled = true;
  contextCompactBtnEl.textContent = 'Compacting…';
  addDebugLine('Context compaction requested.', 'cyan');
  try {
    const res = await fetch('/api/context/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {throw new Error(data?.error || 'Failed to compact context');}
    const compacted = data?.result?.compacted;
    const reason = data?.result?.reason ? ` (${data.result.reason})` : '';
    addDebugLine(compacted === false ? `Context compaction skipped${reason}.` : 'Context compaction finished.', compacted === false ? 'pink' : 'cyan');
    contextCompactBtnEl.textContent = compacted === false ? 'Skipped' : 'Done';
    setTimeout(() => {
      if (contextCompactBtnEl) {
        contextCompactBtnEl.disabled = false;
        contextCompactBtnEl.textContent = prevText || 'Compact';
      }
    }, 2200);
  } catch (error) {
    addDebugLine(`Context compaction failed: ${error?.message || error}`, 'pink');
    contextCompactBtnEl.disabled = false;
    contextCompactBtnEl.textContent = prevText || 'Compact';
  }
}

function setConsoleTab(tab) {
  consoleTabs.active = tab === 'claude' ? 'claude' : 'terminal';
  const isTerminal = consoleTabs.active === 'terminal';
  const isClaude = consoleTabs.active === 'claude';
  consoleTabTerminalEl?.classList.toggle('is-active', isTerminal);
  consoleTabClaudeEl?.classList.toggle('is-active', isClaude);
  consolePaneTerminalEl?.classList.toggle('is-active', isTerminal);
  consolePaneClaudeEl?.classList.toggle('is-active', isClaude);
  if (isClaude) {
    renderClaudePanel();
    if (claude.running) {ensureClaudePolling();}
    requestAnimationFrame(() => {
      maybeScrollClaudeOutput();
      resizeClaudeSession();
      claude.term?.focus();
      if (!claude.term && claudeComposerInputEl) {claudeComposerInputEl.focus();}
    });
  }
}

function bindConsoleTabEvents() {
  consoleTabTerminalEl?.addEventListener('click', () => setConsoleTab('terminal'));
  consoleTabClaudeEl?.addEventListener('click', () => setConsoleTab('claude'));
}

function bindClaudeEvents() {
  if (claudeStartBtnEl) {
    claudeStartBtnEl.onclick = startClaude;
    claudeStartBtnEl.dataset.bound = '1';
  }
  if (claudeStopBtnEl) {claudeStopBtnEl.onclick = stopClaude;}
  if (claudeRestartBtnEl) {claudeRestartBtnEl.onclick = restartClaude;}
  claudeCwdInputEl?.addEventListener('change', event => {
    claude.cwd = String(event.target.value || '').trim() || getDefaultClaudeCwd();
  });
  claudeAutoScrollEl?.addEventListener('change', event => {
    claude.autoScroll = !!event.target.checked;
  });
  claudeTerminalHostEl?.addEventListener('click', () => claude.term?.focus());
  claudeComposerInputEl?.addEventListener('input', event => {
    claude.composerDraft = event.target.value || '';
    if (claude.composerStatusTone === 'error' || claude.composerStatusTone === 'success') {
      setClaudeComposerStatus('Enter 发送 · Shift+Enter 换行', 'hint');
    }
    renderClaudeComposer();
  });
  claudeComposerInputEl?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') {return;}
    if (event.shiftKey || event.isComposing) {return;}
    event.preventDefault();
    submitClaudeComposer().catch(() => {});
  });
  claudeComposerFormEl?.addEventListener('submit', event => {
    event.preventDefault();
    submitClaudeComposer().catch(() => {});
  });
  window.__CLAUDE_PANEL_BOUND__ = true;
}

function initClaudePanel() {
  bindConsoleTabEvents();
  bindClaudeEvents();
  renderClaudePanel();
  let claudeResizeScheduled = false;
  const scheduleClaudeResize = () => {
    if (claudeResizeScheduled || consoleTabs.active !== 'claude') {return;}
    claudeResizeScheduled = true;
    requestAnimationFrame(() => {
      claudeResizeScheduled = false;
      resizeClaudeSession();
    });
  };
  if (window.ResizeObserver && claudeTerminalHostEl) {
    const ro = new ResizeObserver(() => {
      scheduleClaudeResize();
      resizeClaudeComposer();
    });
    ro.observe(claudeTerminalHostEl);
    if (claudeComposerInputEl) {ro.observe(claudeComposerInputEl);}
  }
  window.addEventListener('resize', () => {
    scheduleClaudeResize();
  });
  setConsoleTab('claude');
  fetchClaudeState().catch(error => {
    claude.error = error?.message || String(error);
    renderClaudePanel();
  });
}

async function runTerminalCommand(command) {
  const res = await fetch('/api/terminal/input', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: terminalSessionId, cwd: currentDir || '.', text: `${command}
` }),
  });
  const data = await res.json();
  if (!res.ok) {throw new Error(data.error || 'terminal input failed');}
  if (terminalOutputEl) {terminalOutputEl.textContent = data.output || '';}
  terminalOutputEl.scrollTop = terminalOutputEl.scrollHeight;
}

function renderFileTree(entries) {
  if (!fileTreeEl) {return;}
  fileTreeEl.innerHTML = '';
  for (const entry of entries) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `file-tree-item ${entry.type}`;
    item.textContent = entry.name || entry.path;
    if (entry.type === 'file') {item.addEventListener('click', () => loadFile(entry.path));}
    else {item.addEventListener('click', () => openDirectory(entry.path));}
    fileTreeEl.appendChild(item);
  }
}

function syncFileNavButtons() {
  if (fileBackBtnEl) {fileBackBtnEl.disabled = currentDir === '.';}
  if (fileForwardBtnEl) {fileForwardBtnEl.disabled = lastVisitedDirs.length === 0;}
}

function escapeHtml(text) { return text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function renderChatMarkdown(text = '') {
  const source = escapeHtml(String(text || ''));
  const fenced = [];
  const fencedRe = /```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g;
  let html = source.replace(fencedRe, (_, lang = '', code = '') => {
    const token = `__CODE_BLOCK_${fenced.length}__`;
    fenced.push(`<pre class="chat-code-block"><code>${code}</code></pre>`);
    return token;
  });
  html = html
    .replace(/^###\s+(.+)$/gm, '<div class="chat-md-h3">$1</div>')
    .replace(/^##\s+(.+)$/gm, '<div class="chat-md-h2">$1</div>')
    .replace(/^#\s+(.+)$/gm, '<div class="chat-md-h1">$1</div>')
    .replace(/^>\s+(.+)$/gm, '<div class="chat-md-quote">$1</div>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a class="chat-link" href="$2" target="_blank" rel="noreferrer">$1</a>');

  const lines = html.split('\n');
  const out = [];
  let inList = false;
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      if (!inList) {
        out.push('<ul class="chat-md-list">');
        inList = true;
      }
      out.push(`<li>${(bullet || numbered)[1]}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (!line.trim()) {
      out.push('<div class="chat-md-space"></div>');
    } else if (/^<div class="chat-md-(h1|h2|h3|quote)">/.test(line) || line.startsWith('__CODE_BLOCK_')) {
      out.push(line);
    } else {
      out.push(`<div class="chat-md-p">${line}</div>`);
    }
  }
  if (inList) {out.push('</ul>');}
  html = out.join('');
  fenced.forEach((block, index) => {
    html = html.replace(`__CODE_BLOCK_${index}__`, block);
  });
  return html;
}

function renderMarkdownHighlight(text, filePath = '') {
  const escaped = escapeHtml(text);
  const isMarkdown = /\.md$/i.test(filePath || '');
  if (!isMarkdown) {
    if (fileModeBadgeEl) {fileModeBadgeEl.textContent = 'plain';}
    return escaped;
  }
  if (fileModeBadgeEl) {fileModeBadgeEl.textContent = 'markdown';}
  return escaped
    .replace(/^(#{1,6}\s.*)$/gm, '<span class="md-h1">$1</span>')
    .replace(/^(\s*[-*+]\s.*)$/gm, '<span class="md-list">$1</span>')
    .replace(/^(>\s.*)$/gm, '<span class="md-quote">$1</span>')
    .replace(/(```[\s\S]*?```)/g, '<span class="md-codefence">$1</span>')
    .replace(/(`[^`]+`)/g, '<span class="md-inline-code">$1</span>')
    .replace(/(\*\*[^*]+\*\*)/g, '<span class="md-strong">$1</span>')
    .replace(/(\*[^*]+\*)/g, '<span class="md-emph">$1</span>')
    .replace(/(\[[^\]]+\]\([^)]+\))/g, '<span class="md-link-text">$1</span>');
}
function syncEditorHighlight() {
  if (!fileEditorEl || !fileHighlightEl) {return;}
  fileHighlightEl.innerHTML = renderMarkdownHighlight(fileEditorEl.value, currentFilePath || '');
  fileHighlightEl.scrollTop = fileEditorEl.scrollTop;
  fileHighlightEl.scrollLeft = fileEditorEl.scrollLeft;
}

async function loadFile(relPath) {
  if (!fileEditorEl || !activeFilePathEl) {return;}
  const dir = relPath.includes('/') ? relPath.split('/').slice(0, -1).join('/') : '.';
  if (dir !== currentDir) {await loadFileTree(dir || '.');}
  currentFilePath = relPath;
  activeFilePathEl.innerHTML = `<span class="semantic-label">file</span> <span class="semantic-value">${relPath}</span>`;
  fileEditorEl.value = 'Loading…';
  syncEditorHighlight();
  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(relPath)}`);
    const data = await res.json();
    if (!res.ok) {throw new Error(data.error || 'file load failed');}
    currentFileOriginal = data.content;
    fileEditorEl.value = data.content;
    syncEditorHighlight();
    addDebugLine(`Loaded file preview: ${relPath}`, 'cyan');
  } catch (error) {
    fileEditorEl.value = `Failed to load file:\n${error.message || error}`;
    syncEditorHighlight();
  }
}

async function loadFileTree(dir = currentDir) {
  if (!fileTreeEl) {return;}
  fileTreeEl.innerHTML = '<div class="event-sub"><span class="semantic-value">Loading files…</span></div>';
  try {
    const res = await fetch(`/api/files?dir=${encodeURIComponent(dir)}`);
    const data = await res.json();
    if (!res.ok) {throw new Error(data.error || 'file list failed');}
    currentDir = data.currentDir || '.';
    if (fileBrowserRootEl) {fileBrowserRootEl.textContent = currentDir;}
    if (terminalCwdEl) {terminalCwdEl.textContent = currentDir;}
    renderFileTree(data.entries || []);
    syncFileNavButtons();
  } catch (error) {
    fileTreeEl.innerHTML = `<div class="event-sub"><span class="semantic-value">${error.message || error}</span></div>`;
  }
}

function openDirectory(dirPath) {
  if (currentDir && currentDir !== dirPath) {lastVisitedDirs.push(currentDir);}
  loadFileTree(dirPath);
}

function persistLatestAssistantReply(text = '', meta = {}) {
  try {
    warnRoadmapLeak('persistLatestAssistantReply(input)', text);
    const normalized = stripRoadmapBlockForDisplay(String(text || '')).trim();
    if (!normalized) {return;}
    if (meta?.aborted === true) {return;}
    localStorage.setItem(LAST_ASSISTANT_REPLY_KEY, JSON.stringify({
      text: normalized,
      runId: meta?.runId || null,
      aborted: false,
      updatedAt: new Date().toISOString(),
    }));
  } catch {}
}

function markLatestAssistantReplyAborted(runId = null) {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_ASSISTANT_REPLY_KEY) || 'null') || {};
    localStorage.setItem(LAST_ASSISTANT_REPLY_KEY, JSON.stringify({
      ...raw,
      runId: runId || raw.runId || null,
      aborted: true,
      updatedAt: new Date().toISOString(),
    }));
  } catch {}
}

function getPersistedLatestAssistantReplyMeta() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_ASSISTANT_REPLY_KEY) || 'null');
    return {
      text: String(raw?.text || '').trim(),
      runId: raw?.runId || null,
      aborted: raw?.aborted === true,
    };
  } catch {
    return { text: '', runId: null, aborted: false };
  }
}

function getPersistedLatestAssistantReply() {
  return getPersistedLatestAssistantReplyMeta().text;
}

function tailSnippet(text = '', maxChars = 1200) {
  const normalized = String(text || '').replace(/\r/g, '').trim();
  if (!normalized) {return '';}
  if (normalized.length <= maxChars) {return normalized;}
  return `…\n${normalized.slice(-maxChars).trim()}`;
}

function buildContinuePayload() {
  const latest = getPersistedLatestAssistantReplyMeta();
  const lastAssistantReply = latest.text;
  warnRoadmapLeak('buildContinuePayload(source)', lastAssistantReply);
  if (!lastAssistantReply || latest.aborted || activeRunState === 'streaming' || activeRunState === 'aborting') {return '继续';}
  const replyTail = tailSnippet(stripRoadmapBlockForDisplay(lastAssistantReply), 1200);
  return [
    '继续上一条 assistant 回复里最后明确提出的事情。',
    '',
    '上一条 assistant 回复（尾段，作为继续锚点）：',
    replyTail,
    '',
    '要求：默认延续上一条回复最后提出的具体动作，不要重开话题。',
  ].join('\n');
}

function submitChatText(text = '', options = {}) {
  const value = String(text || '').trim();
  const outboundText = String(options?.outboundText || value).trim();
  const wsState = !ws ? 'no-ws' : ws.readyState;
  addDebugLine(`submitChatText: len=${outboundText.length} ws=${wsState}`, ws && ws.readyState === WebSocket.OPEN ? 'cyan' : 'pink');
  if (!value || !outboundText || !ws || ws.readyState !== WebSocket.OPEN) {return;}
  try {
    addDebugLine('submitChatText: calling ws.send', 'cyan');
    ws.send(JSON.stringify({ type: 'send', text: outboundText }));
    addDebugLine('submitChatText: ws.send returned', 'cyan');
  } catch (error) {
    addDebugLine(`submitChatText: ws.send threw ${error?.message || error}`, 'pink');
    throw error;
  }
  try {
    addMessage('user', value);
  } catch (error) {
    addDebugLine(`submitChatText: addMessage threw ${error?.message || error}`, 'pink');
  }
  try {
    inputEl.value = '';
    resizeComposer();
  } catch (error) {
    addDebugLine(`submitChatText: composer reset threw ${error?.message || error}`, 'pink');
  }
  streamingEl = null;
  streamingRunId = null;
  try {
    setMood('thinking', 'User prompt sent; waiting for final routing.');
  } catch (error) {
    addDebugLine(`submitChatText: setMood threw ${error?.message || error}`, 'pink');
  }
  try {
    setRouting('queued', 'phase=queued · mode=thinking');
  } catch (error) {
    addDebugLine(`submitChatText: setRouting threw ${error?.message || error}`, 'pink');
  }
}

function addMessage(role, text, extraClass = '', options = {}) {
  const row = document.createElement('div');
  row.className = `msg-row ${role}`.trim();
  if (options.runId) {row.dataset.runId = String(options.runId);}
  if (options.messageRole) {row.dataset.messageRole = String(options.messageRole);}
  const avatar = document.createElement('div');
  avatar.className = `avatar ${role}`.trim();
  const avatarSrc = avatarImageSrc(role);
  if (avatarSrc) {
    const img = document.createElement('img');
    img.className = 'avatar-img';
    img.alt = role === 'user' ? 'Xin avatar' : 'avatar';
    img.onerror = () => {
      img.remove();
      avatar.textContent = avatarLabel(role);
    };
    img.src = `${avatarSrc}?v=1`;
    avatar.appendChild(img);
  } else {avatar.textContent = avatarLabel(role);}
  const bubbleWrap = document.createElement('div');
  bubbleWrap.className = 'bubble-wrap';
  const meta = document.createElement('div');
  meta.className = `msg-meta ${role}`.trim();
  meta.textContent = `${role === 'user' ? 'Xin' : 'Vio'} · ${formatStamp()}`;
  const el = document.createElement('div');
  el.className = `msg ${role} ${extraClass}`.trim();
  el.innerHTML = renderChatMarkdown(text);
  bubbleWrap.appendChild(meta);
  bubbleWrap.appendChild(el);
  row.appendChild(avatar);
  row.appendChild(bubbleWrap);
  chatEl.appendChild(row);
  requestAnimationFrame(() => { chatEl.scrollTop = chatEl.scrollHeight; });
  return el;
}

function getStreamingMessageEl(runId = null) {
  if (streamingEl && streamingEl.isConnected && (!runId || streamingRunId === runId)) {return streamingEl;}
  if (!runId) {return null;}
  const row = chatEl?.querySelector(`.msg-row.assistant[data-message-role="stream"][data-run-id="${CSS.escape(String(runId))}"]`);
  const msgEl = row?.querySelector('.msg.assistant.stream') || row?.querySelector('.msg.assistant');
  if (msgEl) {
    streamingEl = msgEl;
    streamingRunId = runId;
    return msgEl;
  }
  return null;
}

function ensureStreamingMessageEl(runId = null, text = '') {
  const existing = getStreamingMessageEl(runId);
  if (existing) {return existing;}
  const el = addMessage('assistant', text, 'stream', { runId, messageRole: 'stream' });
  streamingEl = el;
  streamingRunId = runId || null;
  return el;
}

function finalizeStreamingMessage(runId = null, finalText = '') {
  const target = getStreamingMessageEl(runId);
  if (target) {
    target.innerHTML = renderChatMarkdown(finalText);
    target.classList.remove('stream');
    const row = target.closest('.msg-row');
    if (row) {row.dataset.messageRole = 'final';}
  } else {
    addMessage('assistant', finalText, '', { runId, messageRole: 'final' });
  }
  if (!runId || streamingRunId === runId) {
    streamingEl = null;
    streamingRunId = null;
  }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.addEventListener('open', () => {
    statusEl.textContent = 'wrapper connected';
    applyDotState(wrapperDotEl, 'link', 'online');
    addDebugLine('Wrapper websocket connected.', 'cyan');
  });
  ws.addEventListener('message', ev => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'status') {
      statusEl.textContent = msg.connected ? `gateway connected · ${msg.sessionKey}` : 'gateway connecting…';
      applyDotState(wrapperDotEl, 'link', 'online');
      applyDotState(gatewayDotEl, 'link', msg.connected ? 'online' : 'offline');
      sessionKeyEl.innerHTML = `<span class="semantic-label">session:</span> <span class="semantic-value">${msg.sessionKey || 'unknown'}</span>`;
      return;
    }
    if (msg.type === 'ack') {
      resetStoppedUiForNewRun();
      activeRunId = msg.runId || activeRunId;
      activeRunState = 'streaming';
      stopRequestedAt = null;
      if (msg.runId) {registerChatRun(msg.runId);}
      syncStopButton();
      syncContinueButton();
      addDebugLine(`Prompt accepted · run ${String(msg.runId || '').slice(0, 8)}`, 'cyan');
      fetch('/api/coms/token-saver')
        .then(res => res.json())
        .then(data => {
          const tokenSaver = data?.tokenSaver;
          if (tokenSaver?.enabled && tokenSaver?.stats?.last) {addDebugLine(`Token saver: saved ~${tokenSaver.stats.last.savedChars} chars this send`, 'cyan');}
        })
        .catch(() => {});
      return;
    }
    if (msg.type === 'error') {
      const errorText = msg.error || 'wrapper error';
      try {
        addMessage('assistant', `Error: ${errorText}`);
      } catch (error) {
        addDebugLine(`ws error render failed: ${error?.message || error}`, 'pink');
      }
      const fallbackMode = latestWrapperRuntime?.lightOutput || latestWrapperRuntime?.mood || 'idle';
      try {
        setMood(fallbackMode, `send failed: ${errorText}`, latestWrapperRuntime || null);
      } catch (error) {
        addDebugLine(`ws error setMood failed: ${error?.message || error}`, 'pink');
      }
      try {
        setRouting('send failed', errorText);
      } catch (error) {
        addDebugLine(`ws error setRouting failed: ${error?.message || error}`, 'pink');
      }
      streamingEl = null;
      return;
    }
    if (msg.type === 'tokens') {
      const last = msg.last;
      if (lastTokensDetailEl) {lastTokensDetailEl.innerHTML = last ? `<span class="semantic-label">in</span> <span class="semantic-value">${last.input}</span><br><span class="semantic-label">out</span> <span class="semantic-value">${last.output}</span><br><span class="semantic-label">total</span> <span class="semantic-value">${last.total}</span>` : '<span class="semantic-value">n/a</span>';}
      if (totalTokensDetailEl) {totalTokensDetailEl.innerHTML = `<span class="semantic-label">in</span> <span class="semantic-value">${msg.totalInput}</span><br><span class="semantic-label">out</span> <span class="semantic-value">${msg.totalOutput}</span><br><span class="semantic-label">total</span> <span class="semantic-value">${msg.total}</span>`;}
      if (modelWindowDetailEl) {modelWindowDetailEl.innerHTML = msg.modelLimit ? `<span class="semantic-value">${msg.modelName || 'model'}</span>` : `<span class="semantic-value">${msg.modelName || 'n/a'}</span>`;}
      const pct = Number(msg.modelUsagePercent ?? 0);
      const windowState = !msg.modelLimit ? 'safe' : pct >= 90 ? 'danger' : pct >= 75 ? 'high' : pct >= 50 ? 'mid' : 'safe';
      applyDotState(modelWindowDotEl, 'window', windowState);
      renderContextTelemetry(msg);
      return;
    }
    if (msg.type === 'mood') {
      const mode = msg.mode || 'unknown';
      const state = msg.state || {};
      const runtime = msg.runtime || null;
      const phase = msg.detail?.phase || runtime?.phase || null;
      const proxy = routingProxyLabel(mode, phase);
      try {
        setMood(mode, `Body state: ${state.current_status || mode} · light ${runtime?.lightOutput || state.light_output || mode}`, runtime);
      } catch (error) {
        addDebugLine(`ws mood setMood failed: ${error?.message || error}`, 'pink');
      }
      try {
        setRouting(proxy, `phase=${phase || 'n/a'} · mode=${mode}`);
      } catch (error) {
        addDebugLine(`ws mood setRouting failed: ${error?.message || error}`, 'pink');
      }
      try {
        if (bodyLinkValueEl) {bodyLinkValueEl.textContent = runtime?.lightOutput || mode;}
        if (bodyLinkDetailEl) {bodyLinkDetailEl.textContent = `current=${state.current_status || mode} · stable=${state.last_stable_status || mode} · light=${state.light_output || runtime?.lightOutput || mode}`;}
        if (state && Object.keys(state).length) {setEnvironmentTelemetry({ ...state, wrapper_runtime: runtime, effective_light_output: runtime?.lightOutput || mode });}
      } catch (error) {
        addDebugLine(`ws mood telemetry render failed: ${error?.message || error}`, 'pink');
      }
      return;
    }
    if (msg.type === 'token-saver') {
      renderTokenSaverState(msg.tokenSaver || {});
      addDebugLine(`Token saver ${msg.tokenSaver?.enabled ? 'enabled' : 'disabled'}.`, 'cyan');
      return;
    }
    if (msg.type === 'claude-state') {
      try {applyClaudeStateData(msg);} catch (error) {addDebugLine(`ws claude-state apply failed: ${error?.message || error}`, 'pink');}
      return;
    }
    if (msg.type === 'chat') {
      const event = msg.event;
      if (ignoreAbortedRunEvent(event)) {return;}
      applyChatEventToActiveRun(event);
      return;
    }
  } catch (error) {
      addDebugLine(`ws message handler failed: ${error?.message || error}`, 'pink');
    }
  });
  ws.addEventListener('close', () => {
    statusEl.textContent = 'wrapper disconnected; retrying…';
    applyDotState(wrapperDotEl, 'link', 'offline');
    applyDotState(gatewayDotEl, 'link', 'offline');
    if (wrapperRestartBtnEl) {
      wrapperRestartBtnEl.disabled = false;
      if (String(wrapperRestartBtnEl.textContent || '').startsWith('Restarting')) {wrapperRestartBtnEl.textContent = 'Restart';}
    }
    if (gatewayRestartBtnEl) {
      gatewayRestartBtnEl.disabled = false;
      if (String(gatewayRestartBtnEl.textContent || '').startsWith('Restarting')) {gatewayRestartBtnEl.textContent = 'Restart';}
    }
    addDebugLine('Wrapper websocket disconnected; retrying…', 'pink');
    setTimeout(connect, 1000);
  });
}

formEl?.addEventListener('submit', ev => {
  ev.preventDefault();
  submitChatText(inputEl.value);
});

function syncContinueButton() {
  if (!continueBtnEl) {return;}
  const latest = getPersistedLatestAssistantReplyMeta();
  const blocked = latest.aborted || activeRunState === 'streaming' || activeRunState === 'aborting' || activeRunState === 'aborted';
  continueBtnEl.disabled = blocked;
}

continueBtnEl?.addEventListener('click', () => {
  if (continueBtnEl?.disabled) {return;}
  submitChatText('继续', { outboundText: buildContinuePayload() });
});

stopBtnEl?.addEventListener('click', () => {
  if (!activeRunId || activeRunState !== 'streaming') {return;}
  activeRunState = 'aborting';
  syncStopButton();
  stopRequestedAt = Date.now();
  abortedRunIds.add(activeRunId);
  if (abortedRunIds.size > 200) {abortedRunIds.clear();}
  updateChatRunStatus(activeRunId, 'aborted');
  const stoppedRunId = activeRunId;
  streamingEl = null;
  streamingRunId = null;
  activeRunId = null;
  activeRunState = 'aborted';
  addDebugLine(`User stopped run ${String(stoppedRunId).slice(0, 8)}`, 'pink');
  markLatestAssistantReplyAborted(stoppedRunId);
  addMessage('assistant', '(aborted)');
  syncStopButton();
  syncContinueButton();
});

inputEl?.addEventListener('input', resizeComposer);
inputEl?.addEventListener('keydown', event => {
  if (event.key !== 'Enter') {return;}
  if (event.metaKey || event.ctrlKey) {
    event.preventDefault();
    submitChatText(inputEl.value);
    return;
  }
  if (event.shiftKey) {
    event.preventDefault();
    submitChatText('继续', { outboundText: buildContinuePayload() });
    return;
  }
});
window.addEventListener('resize', resizeComposer);
window.addEventListener('resize', resizeClaudeComposer);
fileBackBtnEl?.addEventListener('click', () => {
  if (currentDir === '.') {return;}
  const parent = currentDir.includes('/') ? currentDir.split('/').slice(0, -1).join('/') : '.';
  if (currentDir) {lastVisitedDirs.push(currentDir);}
  loadFileTree(parent || '.');
});
fileForwardBtnEl?.addEventListener('click', () => {
  const prev = lastVisitedDirs.pop();
  if (!prev) {return;}
  loadFileTree(prev);
});
fileRefreshBtnEl?.addEventListener('click', () => loadFileTree(currentDir));
openDirBtnEl?.addEventListener('click', async () => {
  try {
    await openCurrentDirectoryInFinder();
  } catch (error) {
    appendTerminalOutput(error.message || String(error), 'pink');
  }
});
terminalFormEl?.addEventListener('submit', async ev => {
  ev.preventDefault();
  const command = String(terminalInputEl?.value || '').trim();
  if (!command) {return;}
  const execTaskId = allocExecTaskId();
  registerExecTask(execTaskId, command);
  syncTerminalTaskButtons();
  addDebugLine(`Exec task started ${execTaskId} · ${command}`, 'cyan');
  if (terminalInputEl) {terminalInputEl.value = '';}
  try {
    await runTerminalCommand(command);
    updateExecTaskStatus(execTaskId, 'completed');
    syncTerminalTaskButtons();
    addDebugLine(`Exec task completed ${execTaskId}`, 'cyan');
  } catch (error) {
    updateExecTaskStatus(execTaskId, 'failed');
    syncTerminalTaskButtons();
    appendTerminalOutput(error.message || String(error), 'pink');
    addDebugLine(`Exec task failed ${execTaskId}: ${error.message || error}`, 'pink');
  }
});

terminalDetachBtnEl?.addEventListener('click', () => {
  const task = findLatestExecTask('running');
  if (!task) {return;}
  updateExecTaskStatus(task.taskId, 'detached', {
    visibleInUi: false,
    detachedAt: Date.now(),
  });
  syncTerminalTaskButtons();
  addDebugLine(`Exec task detached ${task.taskId} (still running)`, 'pink');
});

terminalTerminateBtnEl?.addEventListener('click', async () => {
  const task = findLatestExecTask('running') || findLatestExecTask('detached');
  if (!task || !terminalSessionId) {return;}
  updateExecTaskStatus(task.taskId, 'terminating', {
    terminationRequestedAt: Date.now(),
    terminationError: null,
  });
  syncTerminalTaskButtons();
  addDebugLine(`Exec task terminating ${task.taskId}`, 'pink');
  try {
    const res = await fetch('/api/terminal/terminate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: terminalSessionId }),
    });
    const data = await res.json();
    if (!res.ok) {throw new Error(data.error || 'terminal terminate failed');}
    if (data.status === 'terminated' || data.status === 'exited') {
      updateExecTaskStatus(task.taskId, 'terminated', {
        terminatedAt: Date.now(),
        terminationError: data.terminationError || null,
      });
      addDebugLine(`Exec task terminated ${task.taskId}`, 'pink');
    } else if (data.status === 'failed') {
      updateExecTaskStatus(task.taskId, 'failed', {
        terminationError: data.terminationError || 'terminate failed',
      });
      addDebugLine(`Exec task terminate failed ${task.taskId}: ${data.terminationError || 'unknown error'}`, 'pink');
    }
  } catch (error) {
    updateExecTaskStatus(task.taskId, 'failed', {
      terminationError: error.message || String(error),
    });
    addDebugLine(`Exec task terminate failed ${task.taskId}: ${error.message || error}`, 'pink');
  } finally {
    syncTerminalTaskButtons();
  }
});
cameraCaptureBtnEl?.addEventListener('click', () => runCameraCapture());
gestureWatcherBtnEl?.addEventListener('click', async () => {
  try {
    const turnOn = !String(gestureWatcherBtnEl.textContent || '').includes('on');
    await setGestureWatcher(turnOn);
    await refreshCameraTelemetry();
  } catch (error) {
    addDebugLine(`Watcher toggle failed: ${error.message || error}`, 'pink');
  }
});

tokenSaverToggleBtnEl?.addEventListener('click', async () => {
  const nextEnabled = String(tokenSaverToggleBtnEl.dataset.enabled || 'false') !== 'true';
  tokenSaverToggleBtnEl.disabled = true;
  try {
    await setTokenSaverEnabled(nextEnabled);
  } catch (error) {
    addDebugLine(`Token saver toggle failed: ${error.message || error}`, 'pink');
  } finally {
    tokenSaverToggleBtnEl.disabled = false;
  }
});

tokenSaverPhase1BtnEl?.addEventListener('click', async () => {
  const nextEnabled = String(tokenSaverPhase1BtnEl.dataset.enabled || 'false') !== 'true';
  tokenSaverPhase1BtnEl.disabled = true;
  try {
    await updateTokenSaverConfig({ phase1Summary: nextEnabled });
  } catch (error) {
    addDebugLine(`Token saver L1 toggle failed: ${error.message || error}`, 'pink');
  } finally {
    tokenSaverPhase1BtnEl.disabled = false;
  }
});

tokenSaverPhase2BtnEl?.addEventListener('click', async () => {
  const nextEnabled = String(tokenSaverPhase2BtnEl.dataset.enabled || 'false') !== 'true';
  tokenSaverPhase2BtnEl.disabled = true;
  try {
    await updateTokenSaverConfig({ phase2ToolCompression: nextEnabled });
  } catch (error) {
    addDebugLine(`Token saver L2 toggle failed: ${error.message || error}`, 'pink');
  } finally {
    tokenSaverPhase2BtnEl.disabled = false;
  }
});
fileUndoBtnEl?.addEventListener('click', () => {
  if (!fileEditorEl) {return;}
  fileEditorEl.value = currentFileOriginal || '';
  syncEditorHighlight();
});
fileSaveBtnEl?.addEventListener('click', async () => {
  if (!currentFilePath || !fileEditorEl) {return;}
  try {
    const res = await fetch('/api/file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentFilePath, content: fileEditorEl.value }),
    });
    const data = await res.json();
    if (!res.ok) {throw new Error(data.error || 'save failed');}
    currentFileOriginal = fileEditorEl.value;
    if (data?.safeEdit) {
      addDebugLine(`Saved file: ${currentFilePath} · ${summarizeSafeEditResult(data.safeEdit)} · ${String(data.safeEdit.id || '').slice(0, 12)}`, 'cyan');
      const smokeChecks = Array.isArray(data.safeEdit?.checks?.smoke?.checks) ? data.safeEdit.checks.smoke.checks : [];
      for (const check of smokeChecks) {
        addDebugLine(`safe-edit smoke ${check.ok ? 'ok' : 'warn'} · ${check.name}`, check.ok ? 'cyan' : 'pink');
      }
    } else {
      addDebugLine(`Saved file: ${currentFilePath}`, 'cyan');
    }
    await refreshSafeEditState();
  } catch {
    addDebugLine(`Save failed: ${currentFilePath}`, 'pink');
  }
});
fileEditorEl?.addEventListener('input', syncEditorHighlight);
fileEditorEl?.addEventListener('scroll', syncEditorHighlight);

resizeComposer();
resizeClaudeComposer();
applyLayoutPrefs();
fetchServerConfig().catch(() => {});
bindFoldPersistence(cameraFoldEl, 'cameraFoldOpen', false);
bindFoldPersistence(gestureFoldEl, 'gestureFoldOpen', false);
setupResizers();
refreshCameraTelemetry();
refreshVioBodyState();
refreshTokenSaverStats();
refreshDistInfo();
refreshSafeEditState();
syncTerminalTaskButtons();
syncContinueButton();
setInterval(() => {
  if (activeRunState === 'streaming' && lastStreamEventAt && (Date.now() - lastStreamEventAt) > 10000) {
    forceFinalizeFrontState('stream-watchdog-timeout');
  }
}, 2000);
setInterval(refreshCameraTelemetry, 2500);
setInterval(refreshVioBodyState, 5000);
setInterval(refreshTokenSaverStats, 4000);
setInterval(refreshDistInfo, 15000);
setInterval(refreshSafeEditState, 5000);
syncFileNavButtons();
loadFileTree();
ensureTerminalSession().catch(() => {});
try { initClaudePanel(); } catch (error) { addDebugLine(`initClaudePanel failed: ${error?.message || error}`, 'pink'); }
try { renderRunModeChip(); } catch (error) { addDebugLine(`renderRunModeChip failed: ${error?.message || error}`, 'pink'); }
try { fetchRunMode().catch(() => renderRunModeChip()); } catch (error) { addDebugLine(`fetchRunMode failed: ${error?.message || error}`, 'pink'); }
try { runModeChipEl?.addEventListener('click', toggleRunMode); } catch (error) { addDebugLine(`runModeChip bind failed: ${error?.message || error}`, 'pink'); }
distRebuildBtnEl?.addEventListener('click', rebuildDist);
wrapperRestartBtnEl?.addEventListener('click', restartWrapper);
gatewayRestartBtnEl?.addEventListener('click', restartGateway);
contextCompactBtnEl?.addEventListener('click', compactContext);
window.__VIO_APP_LOADED__ = true;
try { connect(); } catch (error) { addDebugLine(`connect failed: ${error?.message || error}`, 'pink'); }
