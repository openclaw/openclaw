// ============================================
// AGENT MODE MODULE - Enhanced
// ============================================
// Depends on: state (global), showNotification, escapeHtml, loadFileTree, openFile

// ============================================
// INITIALIZATION & STATE
// ============================================

function initAgentState() {
  if (!state.agent) {
    state.agent = {
      active: false,
      task: null,
      taskId: null,
      plan: [],
      currentStep: -1,
      changes: [],
      rollbackCommit: null,
      paused: false,
      error: null,
      mode: 'safe',
      thinkingBuffer: '',
      filesAffected: [],
      startTime: null,
      verification: { running: false, typescript: null, eslint: null, tests: null }
    };
  }
  
  // Restore persisted task if exists
  restorePersistedTask();
}

function setAgentMode(mode) {
  state.agent.mode = mode;
  localStorage.setItem('agentMode', mode);
  console.log('Agent mode set to:', mode);
}

function generateAgentId() {
  return 'agent-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

// ============================================
// TASK PERSISTENCE
// ============================================

function persistTask() {
  if (!state.agent.active) return;
  
  const taskData = {
    taskId: state.agent.taskId,
    task: state.agent.task,
    plan: state.agent.plan,
    currentStep: state.agent.currentStep,
    changes: state.agent.changes,
    rollbackCommit: state.agent.rollbackCommit,
    mode: state.agent.mode,
    startTime: state.agent.startTime,
    filesAffected: state.agent.filesAffected
  };
  
  localStorage.setItem('agentTask', JSON.stringify(taskData));
}

function restorePersistedTask() {
  const saved = localStorage.getItem('agentTask');
  if (!saved) return;
  
  try {
    const taskData = JSON.parse(saved);
    // Only restore if task is recent (within 1 hour)
    if (taskData.startTime && Date.now() - taskData.startTime < 3600000) {
      // Show restore prompt
      showRestorePrompt(taskData);
    } else {
      localStorage.removeItem('agentTask');
    }
  } catch (e) {
    localStorage.removeItem('agentTask');
  }
}

function showRestorePrompt(taskData) {
  const el = document.getElementById('agentTaskInput');
  if (!el) return;
  
  const elapsed = Math.round((Date.now() - taskData.startTime) / 60000);
  const completed = taskData.plan.filter(s => s.status === 'complete').length;
  
  el.innerHTML = `
    <div class="agent-restore-prompt">
      <div class="agent-restore-title">🔄 Resume Previous Task?</div>
      <div class="agent-restore-task">"${escapeHtml(taskData.task.substring(0, 60))}${taskData.task.length > 60 ? '...' : ''}"</div>
      <div class="agent-restore-info">
        ${completed}/${taskData.plan.length} steps completed • ${elapsed}m ago
      </div>
      <div class="agent-restore-actions">
        <button onclick="resumePersistedTask()" class="agent-btn primary">Resume</button>
        <button onclick="discardPersistedTask()" class="agent-btn">Start Fresh</button>
      </div>
    </div>
  `;
}

function resumePersistedTask() {
  const saved = localStorage.getItem('agentTask');
  if (!saved) return;
  
  try {
    const taskData = JSON.parse(saved);
    Object.assign(state.agent, taskData);
    state.agent.active = true;
    
    // Update UI
    document.getElementById('agentTaskInput').classList.add('hidden');
    document.getElementById('agentActive').classList.remove('hidden');
    document.getElementById('agentTaskTitle').textContent = taskData.task.substring(0, 50);
    renderAgentPlan();
    renderFilesAffected();
    updateProgressBar();
    
    showNotification('Task resumed', 'info');
  } catch (e) {
    console.error('Failed to restore task:', e);
  }
}

function discardPersistedTask() {
  localStorage.removeItem('agentTask');
  resetAgentUI();
  renderAgentTaskInput();
}

function renderAgentTaskInput() {
  const el = document.getElementById('agentTaskInput');
  if (!el) return;
  
  el.innerHTML = `
    <div class="agent-empty-state">
      <div class="agent-empty-icon">🤖</div>
      <div class="agent-empty-title">Ready to help you code</div>
      <div class="agent-empty-description">
        Start by describing what you want to build or change. I'll create a plan and execute it step by step.
      </div>
      <div class="agent-input-wrapper">
        <textarea id="agentTaskText" placeholder="What do you want to build?" rows="3"></textarea>
        <button onclick="startAgentTask()" class="agent-start-button">
          <span>▶</span> Start
        </button>
      </div>
      <div class="agent-examples">
        <div class="agent-examples-title">💡 Examples</div>
        <div class="agent-example-item" onclick="setAgentExample('Add user authentication with JWT')">
          <span class="agent-example-icon">🔐</span>
          <span>Add user authentication with JWT</span>
        </div>
        <div class="agent-example-item" onclick="setAgentExample('Refactor this file to TypeScript')">
          <span class="agent-example-icon">📝</span>
          <span>Refactor this file to TypeScript</span>
        </div>
        <div class="agent-example-item" onclick="setAgentExample('Write unit tests for the auth module')">
          <span class="agent-example-icon">🧪</span>
          <span>Write unit tests for the auth module</span>
        </div>
      </div>
    </div>
  `;
  el.classList.remove('hidden');
}

function setAgentExample(text) {
  const textarea = document.getElementById('agentTaskText');
  if (textarea) {
    textarea.value = text;
    textarea.focus();
  }
}

// ============================================
// TASK EXECUTION
// ============================================

async function startAgentTask() {
  const taskText = document.getElementById('agentTaskText')?.value?.trim();
  if (!taskText) {
    showNotification('Please describe a task', 'error');
    return;
  }
  
  // Reset agent state
  state.agent.active = true;
  state.agent.task = taskText;
  state.agent.taskId = generateAgentId();
  state.agent.plan = [];
  state.agent.currentStep = -1;
  state.agent.changes = [];
  state.agent.rollbackCommit = null;
  state.agent.paused = false;
  state.agent.error = null;
  state.agent.thinkingBuffer = '';
  state.agent.filesAffected = [];
  state.agent.startTime = Date.now();
  
  // Update UI
  document.getElementById('agentTaskInput').classList.add('hidden');
  document.getElementById('agentActive').classList.remove('hidden');
  document.getElementById('agentTaskTitle').textContent = taskText.substring(0, 50) + (taskText.length > 50 ? '...' : '');
  document.getElementById('agentStepDescription').innerHTML = `
    <div class="agent-thinking">
      <span class="thinking-dots">●●●</span>
      <span class="thinking-text" id="agentThinkingText">Analyzing task...</span>
    </div>
  `;
  document.getElementById('agentDiffPreview').classList.add('hidden');
  document.getElementById('agentStepActions').classList.add('hidden');
  document.getElementById('agentRollbackSection').classList.add('hidden');
  
  // Clear/init UI elements
  document.getElementById('agentPlan').innerHTML = '';
  document.getElementById('agentStepCount').textContent = '0/0';
  initFilesAffectedUI();
  initProgressBar();
  resetVerificationUI();
  
  // Create rollback point (git stash or commit)
  try {
    const rollbackRes = await fetch('/api/agent/rollback-point', { method: 'POST' });
    const rollbackData = await rollbackRes.json();
    if (rollbackData.commit) {
      state.agent.rollbackCommit = rollbackData.commit;
      document.getElementById('agentRollbackCommit').textContent = rollbackData.commit.substring(0, 7);
      document.getElementById('agentRollbackSection').classList.remove('hidden');
    }
  } catch (e) {
    console.warn('Failed to create rollback point:', e);
  }
  
  // Persist task
  persistTask();
  
  // Send task to server
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'agent:start',
      taskId: state.agent.taskId,
      task: taskText,
      mode: state.agent.mode,
      workspace: state.workspace,
      currentFile: state.currentFile
    }));
  } else {
    showAgentError('Not connected to gateway');
  }
}

function toggleAgentPause() {
  state.agent.paused = !state.agent.paused;
  const btn = document.getElementById('agentPauseBtn');
  btn.textContent = state.agent.paused ? '▶' : '⏸';
  btn.title = state.agent.paused ? 'Resume' : 'Pause';
  
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: state.agent.paused ? 'agent:pause' : 'agent:resume',
      taskId: state.agent.taskId
    }));
  }
}

function cancelAgentTask() {
  if (!confirm('Cancel the current task? Changes made so far will remain.')) return;
  
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'agent:cancel',
      taskId: state.agent.taskId
    }));
  }
  
  localStorage.removeItem('agentTask');
  resetAgentUI();
}

function resetAgentUI() {
  state.agent.active = false;
  state.agent.task = null;
  state.agent.taskId = null;
  state.agent.plan = [];
  state.agent.currentStep = -1;
  state.agent.changes = [];
  state.agent.paused = false;
  state.agent.error = null;
  state.agent.thinkingBuffer = '';
  state.agent.filesAffected = [];
  
  document.getElementById('agentTaskInput').classList.remove('hidden');
  document.getElementById('agentActive').classList.add('hidden');
  renderAgentTaskInput();
}

// ============================================
// STEP ACTIONS
// ============================================

function approveAgentStep() {
  const step = state.agent.plan[state.agent.currentStep];
  if (!step) return;
  
  // Mark current change as approved
  const change = state.agent.changes.find(c => c.stepId === step.id);
  if (change) {
    change.approved = true;
  }
  
  // Send approval to server
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'agent:approve',
      taskId: state.agent.taskId,
      stepId: step.id
    }));
  }
  
  // Update UI
  document.getElementById('agentStepActions').classList.add('hidden');
  document.getElementById('agentStepDescription').innerHTML = `
    <div class="agent-thinking">
      <span class="thinking-dots">●●●</span>
      <span class="thinking-text">Applying changes...</span>
    </div>
  `;
  
  persistTask();
}

function rejectAgentStep() {
  const step = state.agent.plan[state.agent.currentStep];
  if (!step) return;
  
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'agent:reject',
      taskId: state.agent.taskId,
      stepId: step.id
    }));
  }
  
  // Update step status
  step.status = 'skipped';
  renderAgentPlan();
  
  document.getElementById('agentStepActions').classList.add('hidden');
  document.getElementById('agentStepDescription').innerHTML = `
    <div class="agent-thinking">
      <span class="thinking-dots">●●●</span>
      <span class="thinking-text">Skipping step, moving to next...</span>
    </div>
  `;
  
  persistTask();
}

function editAgentStep() {
  const step = state.agent.plan[state.agent.currentStep];
  if (!step) return;
  
  const change = state.agent.changes.find(c => c.stepId === step.id);
  if (!change || !change.newContent) {
    showNotification('No editable content for this step', 'warning');
    return;
  }
  
  // Open the file in editor and let user edit
  openFile(change.file);
  
  // Show notification
  showNotification('Edit the file and then approve the step', 'info');
}

async function rollbackAgentChanges() {
  if (!state.agent.rollbackCommit) {
    showNotification('No rollback point available', 'error');
    return;
  }
  
  if (!confirm('This will undo ALL changes made by the agent. Are you sure?')) return;
  
  try {
    const res = await fetch('/api/agent/rollback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit: state.agent.rollbackCommit })
    });
    
    const data = await res.json();
    
    if (data.ok) {
      showNotification('Successfully rolled back all changes', 'success');
      localStorage.removeItem('agentTask');
      resetAgentUI();
      
      // Refresh file tree and reload open files
      loadFileTree(state.workspace);
      state.panes.forEach(pane => {
        pane.files.forEach((file, path) => {
          reloadFileContent(path, pane.id);
        });
      });
    } else {
      showNotification('Rollback failed: ' + data.error, 'error');
    }
  } catch (e) {
    showNotification('Rollback error: ' + e.message, 'error');
  }
}

async function reloadFileContent(path, paneId) {
  try {
    const res = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    
    const pane = state.panes.find(p => p.id === paneId);
    if (pane && pane.files.has(path)) {
      const file = pane.files.get(path);
      if (file.model) {
        file.model.setValue(data.content);
        file.originalContent = data.content;
        file.modified = false;
        updatePaneTabModified(paneId, path, false);
      }
    }
  } catch (e) {
    console.error('Failed to reload file:', path, e);
  }
}

// ============================================
// PROGRESS BAR
// ============================================

function initProgressBar() {
  let progressBar = document.getElementById('agentProgressBar');
  if (!progressBar) {
    const container = document.getElementById('agentPlanHeader');
    if (container) {
      progressBar = document.createElement('div');
      progressBar.id = 'agentProgressBar';
      progressBar.className = 'agent-progress-bar';
      progressBar.innerHTML = '<div class="agent-progress-fill" id="agentProgressFill"></div>';
      container.appendChild(progressBar);
    }
  }
  updateProgressBar();
}

function updateProgressBar() {
  const fill = document.getElementById('agentProgressFill');
  if (!fill) return;
  
  const total = state.agent.plan.length;
  const completed = state.agent.plan.filter(s => s.status === 'complete' || s.status === 'skipped').length;
  const percent = total > 0 ? (completed / total) * 100 : 0;
  
  fill.style.width = `${percent}%`;
  fill.className = 'agent-progress-fill' + (completed === total && total > 0 ? ' complete' : '');
}

// ============================================
// FILES AFFECTED PANEL
// ============================================

function initFilesAffectedUI() {
  let panel = document.getElementById('agentFilesAffected');
  if (!panel) {
    // Create files affected panel
    const container = document.querySelector('.agent-active-content');
    if (container) {
      panel = document.createElement('div');
      panel.id = 'agentFilesAffected';
      panel.className = 'agent-files-affected hidden';
      panel.innerHTML = `
        <div class="agent-files-header" onclick="toggleFilesAffected()">
          <span>📂 Files Affected</span>
          <span id="agentFilesCount">0</span>
          <span class="agent-files-toggle">▾</span>
        </div>
        <div class="agent-files-list" id="agentFilesList"></div>
        <div class="agent-files-actions">
          <button onclick="approveAllFiles()" class="agent-btn small">Approve All</button>
          <button onclick="reviewEachFile()" class="agent-btn small secondary">Review Each</button>
        </div>
      `;
      container.insertBefore(panel, container.firstChild);
    }
  }
}

function toggleFilesAffected() {
  const list = document.getElementById('agentFilesList');
  if (list) {
    list.classList.toggle('collapsed');
  }
}

function renderFilesAffected() {
  const panel = document.getElementById('agentFilesAffected');
  const list = document.getElementById('agentFilesList');
  const count = document.getElementById('agentFilesCount');
  
  if (!panel || !list) return;
  
  const files = state.agent.filesAffected;
  
  if (files.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  
  panel.classList.remove('hidden');
  count.textContent = files.length;
  
  list.innerHTML = files.map(f => {
    const icon = f.type === 'create' ? '➕' : f.type === 'delete' ? '❌' : '✏️';
    const diffInfo = f.additions || f.deletions ? 
      `<span class="file-diff">${f.additions ? `+${f.additions}` : ''} ${f.deletions ? `-${f.deletions}` : ''}</span>` : '';
    const statusIcon = f.approved ? '✓' : f.rejected ? '✕' : '';
    
    return `
      <div class="agent-file-row ${f.type} ${f.approved ? 'approved' : ''} ${f.rejected ? 'rejected' : ''}">
        <span class="file-icon">${icon}</span>
        <span class="file-name" onclick="showFileDiff('${escapeHtml(f.path)}')">${escapeHtml(f.path)}</span>
        ${diffInfo}
        <span class="file-status">${statusIcon}</span>
        <button class="file-view-btn" onclick="showFileDiff('${escapeHtml(f.path)}')">View</button>
      </div>
    `;
  }).join('');
}

function showFileDiff(path) {
  const change = state.agent.changes.find(c => c.file === path);
  if (change) {
    showAgentDiff(change);
  }
}

function approveAllFiles() {
  state.agent.filesAffected.forEach(f => f.approved = true);
  renderFilesAffected();
  approveAgentStep();
}

function reviewEachFile() {
  // Just show the diff panel - already visible
  showNotification('Review each file and approve individually', 'info');
}

// ============================================
// PLAN RENDERING
// ============================================

function renderAgentPlan() {
  const container = document.getElementById('agentPlan');
  const plan = state.agent.plan;
  
  if (!container) return;
  
  container.innerHTML = plan.map((step, i) => {
    const statusIcon = getStepStatusIcon(step.status);
    const isCurrent = i === state.agent.currentStep;
    const hasSubSteps = step.subSteps && step.subSteps.length > 0;
    
    return `
      <div class="agent-plan-step ${step.status} ${isCurrent ? 'current' : ''}" data-step="${i}">
        <div class="agent-step-main" onclick="toggleStepDetails(${i})">
          <span class="agent-step-status">${statusIcon}</span>
          <div class="agent-step-text">
            ${escapeHtml(step.description || step.title || `Step ${i + 1}`)}
          </div>
          ${hasSubSteps ? '<span class="agent-step-expand">▾</span>' : ''}
        </div>
        ${step.details ? `<div class="agent-step-details">${escapeHtml(step.details)}</div>` : ''}
        ${hasSubSteps ? `
          <div class="agent-substeps collapsed" id="substeps-${i}">
            ${step.subSteps.map((sub, j) => `
              <div class="agent-substep ${sub.status || 'pending'}">
                <span class="substep-icon">${getStepStatusIcon(sub.status || 'pending')}</span>
                <span class="substep-text">${escapeHtml(sub.description || sub)}</span>
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
  
  // Update step count
  const completed = plan.filter(s => s.status === 'complete').length;
  document.getElementById('agentStepCount').textContent = `${completed}/${plan.length}`;
  
  updateProgressBar();
  persistTask();
}

function toggleStepDetails(stepIndex) {
  const substeps = document.getElementById(`substeps-${stepIndex}`);
  if (substeps) {
    substeps.classList.toggle('collapsed');
  }
}

function getStepStatusIcon(status) {
  switch (status) {
    case 'pending': return '○';
    case 'running': return '<span class="status-running">◐</span>';
    case 'complete': return '<span class="status-complete">✓</span>';
    case 'failed': return '<span class="status-failed">✕</span>';
    case 'skipped': return '<span class="status-skipped">⊘</span>';
    default: return '○';
  }
}

// ============================================
// DIFF VIEWER (Enhanced with Monaco)
// ============================================

function showAgentDiff(change) {
  const preview = document.getElementById('agentDiffPreview');
  const fileEl = document.getElementById('agentDiffFile');
  const typeEl = document.getElementById('agentDiffType');
  const contentEl = document.getElementById('agentDiffContent');
  
  if (!preview) return;
  
  fileEl.textContent = change.file;
  typeEl.textContent = change.type;
  typeEl.className = 'agent-diff-type ' + change.type;
  
  // Try to use Monaco diff if available
  if (typeof monaco !== 'undefined' && change.originalContent !== undefined && change.newContent) {
    renderMonacoDiff(contentEl, change);
  } else {
    renderTextDiff(contentEl, change);
  }
  
  preview.classList.remove('hidden');
  
  // Track file as affected
  addFileAffected(change);
}

function renderMonacoDiff(container, change) {
  // Clear existing content
  container.innerHTML = '';
  container.style.height = '300px';
  
  // Create Monaco diff editor
  const diffEditor = monaco.editor.createDiffEditor(container, {
    readOnly: true,
    renderSideBySide: false, // Inline diff
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 12,
    lineNumbers: 'on',
    theme: document.body.classList.contains('theme-light') ? 'vs' : 'vs-dark'
  });
  
  const originalModel = monaco.editor.createModel(change.originalContent || '', getLanguage(change.file));
  const modifiedModel = monaco.editor.createModel(change.newContent || '', getLanguage(change.file));
  
  diffEditor.setModel({
    original: originalModel,
    modified: modifiedModel
  });
  
  // Store for cleanup
  container._diffEditor = diffEditor;
  container._models = [originalModel, modifiedModel];
}

function renderTextDiff(container, change) {
  // Render diff lines (fallback)
  if (change.hunks && change.hunks.length > 0) {
    container.innerHTML = change.hunks.map(hunk => {
      return hunk.lines.map(line => {
        let className = 'agent-diff-line ';
        if (line.startsWith('+')) className += 'added';
        else if (line.startsWith('-')) className += 'removed';
        else className += 'context';
        return `<div class="${className}">${escapeHtml(line.substring(1) || ' ')}</div>`;
      }).join('');
    }).join('<div class="diff-hunk-separator"></div>');
  } else if (change.type === 'create' && change.newContent) {
    const lines = change.newContent.split('\n').slice(0, 50);
    container.innerHTML = lines.map((line, i) => 
      `<div class="agent-diff-line added"><span class="line-num">${i + 1}</span>${escapeHtml(line)}</div>`
    ).join('');
    if (change.newContent.split('\n').length > 50) {
      container.innerHTML += '<div class="agent-diff-line context">... (truncated)</div>';
    }
  } else if (change.type === 'delete') {
    container.innerHTML = '<div class="agent-diff-line removed">File will be deleted</div>';
  } else {
    container.innerHTML = '<div class="agent-diff-line context">No diff available</div>';
  }
}

function getLanguage(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    html: 'html', css: 'css', scss: 'scss', less: 'less',
    json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
    sh: 'shell', bash: 'shell', zsh: 'shell'
  };
  return map[ext] || 'plaintext';
}

function addFileAffected(change) {
  const existing = state.agent.filesAffected.find(f => f.path === change.file);
  if (!existing) {
    state.agent.filesAffected.push({
      path: change.file,
      type: change.type,
      additions: change.newContent ? change.newContent.split('\n').length : 0,
      deletions: change.originalContent ? change.originalContent.split('\n').length : 0,
      approved: false,
      rejected: false
    });
    renderFilesAffected();
  }
}

function showAgentError(message) {
  state.agent.error = message;
  document.getElementById('agentStepDescription').innerHTML = `
    <div class="agent-error">
      <div class="agent-error-title">⚠️ Error</div>
      <div class="agent-error-message">${escapeHtml(message)}</div>
      <button onclick="retryAgentStep()" class="agent-btn small">Retry</button>
    </div>
  `;
}

function retryAgentStep() {
  // Re-send the current step
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'agent:retry',
      taskId: state.agent.taskId,
      stepIndex: state.agent.currentStep
    }));
  }
}

// ============================================
// STREAMING THOUGHT PREVIEW
// ============================================

function updateThinkingText(text) {
  state.agent.thinkingBuffer = (state.agent.thinkingBuffer || '') + text;
  
  const el = document.getElementById('agentThinkingText');
  if (!el) return;
  
  // Show last few meaningful lines
  const lines = state.agent.thinkingBuffer
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('```'))
    .slice(-3);
  
  if (lines.length > 0) {
    el.innerHTML = lines.map(l => escapeHtml(l.substring(0, 80))).join('<br>');
  }
}

// ============================================
// VERIFICATION
// ============================================

async function runAgentVerification() {
  state.agent.verification.running = true;
  
  updateVerificationItem('agentVerifyTs', 'running', 'Running...');
  updateVerificationItem('agentVerifyLint', 'pending', 'Waiting...');
  updateVerificationItem('agentVerifyTest', 'pending', 'Waiting...');
  
  try {
    const res = await fetch('/api/agent/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: state.workspace })
    });
    
    const data = await res.json();
    
    // Update TypeScript
    if (data.typescript) {
      state.agent.verification.typescript = data.typescript;
      updateVerificationItem('agentVerifyTs', 
        data.typescript.passed ? 'pass' : 'fail',
        data.typescript.passed ? 'No errors' : `${data.typescript.errors} errors`,
        data.typescript.output
      );
    } else {
      updateVerificationItem('agentVerifyTs', 'pass', 'Skipped (no TS)');
    }
    
    // Update ESLint
    updateVerificationItem('agentVerifyLint', 'running', 'Running...');
    if (data.eslint) {
      state.agent.verification.eslint = data.eslint;
      updateVerificationItem('agentVerifyLint',
        data.eslint.passed ? 'pass' : 'fail',
        data.eslint.passed ? 'No issues' : `${data.eslint.errors} errors, ${data.eslint.warnings} warnings`,
        data.eslint.output
      );
    } else {
      updateVerificationItem('agentVerifyLint', 'pass', 'Skipped');
    }
    
    // Update Tests
    updateVerificationItem('agentVerifyTest', 'running', 'Running...');
    if (data.tests) {
      state.agent.verification.tests = data.tests;
      updateVerificationItem('agentVerifyTest',
        data.tests.passed ? 'pass' : 'fail',
        data.tests.passed ? `${data.tests.total} passed` : `${data.tests.failed}/${data.tests.total} failed`,
        data.tests.output
      );
    } else {
      updateVerificationItem('agentVerifyTest', 'pass', 'Skipped (no tests)');
    }
    
  } catch (e) {
    showNotification('Verification error: ' + e.message, 'error');
    updateVerificationItem('agentVerifyTs', 'fail', 'Error');
    updateVerificationItem('agentVerifyLint', 'fail', 'Error');
    updateVerificationItem('agentVerifyTest', 'fail', 'Error');
  }
  
  state.agent.verification.running = false;
}

function updateVerificationItem(elementId, status, text, errorOutput = null) {
  const item = document.getElementById(elementId);
  if (!item) return;
  
  const icon = item.querySelector('.verify-icon');
  const statusEl = item.querySelector('.verify-status');
  
  // Remove existing fix button
  const existingBtn = item.querySelector('.verify-fix-btn');
  if (existingBtn) existingBtn.remove();
  
  // Update icon
  icon.className = 'verify-icon ' + status;
  if (status === 'pass') {
    icon.textContent = '✓';
  } else if (status === 'fail') {
    icon.textContent = '✕';
    
    // Add fix button for failures
    const type = elementId.includes('Ts') ? 'typescript' : 
                 elementId.includes('Lint') ? 'eslint' : 'test';
    const fixBtn = document.createElement('button');
    fixBtn.className = 'verify-fix-btn';
    fixBtn.textContent = '🔧 Fix';
    fixBtn.onclick = () => runVerificationFix(type, errorOutput);
    item.appendChild(fixBtn);
  } else if (status === 'running') {
    icon.textContent = '◐';
  } else {
    icon.textContent = '○';
  }
  
  statusEl.textContent = text;
}

async function runVerificationFix(type, errorOutput) {
  showNotification(`🔧 Attempting to fix ${type} errors...`, 'info');
  
  try {
    if (type === 'eslint') {
      const res = await fetch('/api/agent/fix-lint', { method: 'POST' });
      const data = await res.json();
      
      if (data.ok) {
        showNotification('✓ ESLint auto-fix applied', 'success');
        setTimeout(runAgentVerification, 500);
      }
    } else {
      const res = await fetch('/api/agent/ai-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, errors: errorOutput || 'Unknown errors' })
      });
      
      const data = await res.json();
      
      if (data.ok) {
        showNotification('🐾 AI is analyzing and fixing...', 'info');
      } else {
        showNotification(`Fix failed: ${data.error}`, 'error');
      }
    }
  } catch (e) {
    showNotification(`Fix error: ${e.message}`, 'error');
  }
}

function resetVerificationUI() {
  updateVerificationItem('agentVerifyTs', 'pending', 'Not run');
  updateVerificationItem('agentVerifyLint', 'pending', 'Not run');
  updateVerificationItem('agentVerifyTest', 'pending', 'Not run');
  state.agent.verification = { running: false, typescript: null, eslint: null, tests: null };
}

// ============================================
// WEBSOCKET MESSAGE HANDLER
// ============================================

function handleAgentMessage(msg) {
  if (msg.taskId !== state.agent.taskId) return;
  
  switch (msg.type) {
    case 'agent:thinking':
      updateThinkingText(msg.text);
      break;
      
    case 'agent:plan':
      state.agent.plan = msg.plan.map((step, i) => ({
        id: step.id || i,
        description: step.description || step.title || `Step ${i + 1}`,
        status: 'pending',
        details: step.details || '',
        subSteps: step.subSteps || step.steps || []
      }));
      state.agent.thinkingBuffer = '';
      renderAgentPlan();
      initProgressBar();
      showNotification(`Plan created: ${state.agent.plan.length} steps`, 'info');
      break;
      
    case 'agent:step-start':
      state.agent.currentStep = msg.stepIndex;
      state.agent.thinkingBuffer = '';
      if (state.agent.plan[msg.stepIndex]) {
        state.agent.plan[msg.stepIndex].status = 'running';
        renderAgentPlan();
      }
      document.getElementById('agentStepDescription').innerHTML = `
        <div class="agent-thinking">
          <span class="thinking-dots">●●●</span>
          <span class="thinking-text" id="agentThinkingText">${escapeHtml(msg.description || 'Working...')}</span>
        </div>
      `;
      document.getElementById('agentDiffPreview').classList.add('hidden');
      document.getElementById('agentStepActions').classList.add('hidden');
      break;
      
    case 'agent:step-preview':
      const change = {
        stepId: msg.stepId,
        file: msg.file,
        type: msg.changeType,
        originalContent: msg.originalContent,
        newContent: msg.newContent,
        hunks: msg.hunks,
        approved: false
      };
      state.agent.changes.push(change);
      
      document.getElementById('agentStepDescription').innerHTML = `
        <div class="agent-step-action">
          <span class="action-icon">${msg.changeType === 'create' ? '➕' : msg.changeType === 'delete' ? '❌' : '✏️'}</span>
          <span class="action-text">${msg.changeType === 'create' ? 'Creating' : msg.changeType === 'delete' ? 'Deleting' : 'Modifying'}: <strong>${msg.file}</strong></span>
        </div>
      `;
      
      showAgentDiff(change);
      
      if (state.agent.mode === 'auto') {
        approveAgentStep();
      } else {
        document.getElementById('agentStepActions').classList.remove('hidden');
      }
      break;
      
    case 'agent:step-complete':
      if (state.agent.plan[msg.stepIndex]) {
        state.agent.plan[msg.stepIndex].status = 'complete';
        state.agent.plan[msg.stepIndex].details = msg.details || '';
        renderAgentPlan();
      }
      // Mark file as approved
      const fileChange = state.agent.filesAffected.find(f => 
        state.agent.changes.some(c => c.file === f.path && c.stepId === msg.stepId)
      );
      if (fileChange) {
        fileChange.approved = true;
        renderFilesAffected();
      }
      
      // Record AI attribution for the completed step
      const completedChange = state.agent.changes.find(c => c.stepId === msg.stepId);
      if (completedChange && completedChange.newContent && typeof recordAICode === 'function') {
        try {
          const lines = completedChange.newContent.split('\n').length;
          const task = state.agent.task || '';
          const stepDesc = state.agent.plan[msg.stepIndex]?.description || '';
          
          if (completedChange.type === 'create') {
            // New file - all lines are AI-generated
            recordAICode(completedChange.file, 1, lines, {
              task: task.substring(0, 100),
              step: stepDesc
            });
          } else if (completedChange.type === 'modify' && completedChange.originalContent) {
            // Modified file - calculate diff to find new lines
            const oldLines = completedChange.originalContent.split('\n').length;
            const newLines = lines;
            if (newLines > oldLines) {
              // More lines now - record the new portion (simplified)
              recordAICode(completedChange.file, oldLines + 1, newLines, {
                task: task.substring(0, 100),
                step: stepDesc
              });
            }
            // For modifications of existing lines, we'd need a proper diff parser
            // For now, record that AI touched this file
            if (newLines >= 1) {
              recordAICode(completedChange.file, 1, Math.min(newLines, 10), {
                task: task.substring(0, 100),
                step: stepDesc,
                note: 'AI-modified region (approximate)'
              });
            }
          }
          console.log('📊 Recorded AI attribution for:', completedChange.file);
        } catch (attrErr) {
          console.error('Attribution error:', attrErr);
        }
      }
      break;
      
    case 'agent:step-failed':
      if (state.agent.plan[state.agent.currentStep]) {
        state.agent.plan[state.agent.currentStep].status = 'failed';
        state.agent.plan[state.agent.currentStep].details = msg.error || 'Unknown error';
        renderAgentPlan();
      }
      showAgentError(msg.error || 'Step failed');
      break;
      
    case 'agent:complete':
      showNotification('✅ Agent task completed!', 'success');
      localStorage.removeItem('agentTask');
      
      state.agent.plan.forEach(step => {
        if (step.status === 'running') step.status = 'complete';
      });
      renderAgentPlan();
      
      const elapsed = state.agent.startTime ? 
        Math.round((Date.now() - state.agent.startTime) / 1000) : 0;
      
      document.getElementById('agentStepDescription').innerHTML = `
        <div class="agent-complete">
          <div class="complete-icon">✓</div>
          <div class="complete-title">Task Completed</div>
          <div class="complete-summary">${msg.summary || 'All steps executed successfully.'}</div>
          <div class="complete-stats">
            ${state.agent.plan.length} steps • ${state.agent.filesAffected.length} files • ${elapsed}s
          </div>
        </div>
      `;
      document.getElementById('agentStepActions').classList.add('hidden');
      
      if (state.agent.mode !== 'safe') {
        runAgentVerification();
      }
      break;
      
    case 'agent:error':
      showAgentError(msg.error);
      break;
  }
}

// ============================================
// EXPORTS
// ============================================

window.initAgentState = initAgentState;
window.setAgentMode = setAgentMode;
window.startAgentTask = startAgentTask;
window.toggleAgentPause = toggleAgentPause;
window.cancelAgentTask = cancelAgentTask;
window.approveAgentStep = approveAgentStep;
window.rejectAgentStep = rejectAgentStep;
window.editAgentStep = editAgentStep;
window.rollbackAgentChanges = rollbackAgentChanges;
window.runAgentVerification = runAgentVerification;
window.handleAgentMessage = handleAgentMessage;
window.resetAgentUI = resetAgentUI;
window.reloadFileContent = reloadFileContent;
window.resumePersistedTask = resumePersistedTask;
window.discardPersistedTask = discardPersistedTask;
window.toggleFilesAffected = toggleFilesAffected;
window.showFileDiff = showFileDiff;
window.approveAllFiles = approveAllFiles;
window.reviewEachFile = reviewEachFile;
window.toggleStepDetails = toggleStepDetails;
window.retryAgentStep = retryAgentStep;

// Initialize on load
if (typeof state !== 'undefined') {
  initAgentState();
}
