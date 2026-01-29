// ============================================
// DEBUGGER MODULE - Breakpoints & Debug UI
// ============================================
// Phase 1: Breakpoint management
// Phase 2: Debug session control (TODO)
// Phase 3: Variables/Call stack panels (TODO)

const debugState = {
  // Breakpoints: Map<filePath, Set<lineNumber>>
  breakpoints: new Map(),
  // Decoration IDs per editor pane: Map<paneId, decorationIds[]>
  decorations: new Map(),
  // Debug session state
  session: null,
  isDebugging: false,
  isPaused: false,
  currentFile: null,
  currentLine: null,
  // Phase 2-3: Call stack, scopes, and variables
  callStack: [],
  selectedFrameId: 0,
  scopes: [], // Scopes for selected frame
  variables: new Map(), // scopeObjectId -> variables[]
  expandedVars: new Set(), // Set of expanded variable objectIds
  watchExpressions: [], // User-defined watch expressions
};

// ============================================
// BREAKPOINT MANAGEMENT
// ============================================

/**
 * Toggle breakpoint at line
 */
function toggleBreakpoint(filePath, lineNumber) {
  if (!debugState.breakpoints.has(filePath)) {
    debugState.breakpoints.set(filePath, new Set());
  }
  
  const fileBreakpoints = debugState.breakpoints.get(filePath);
  
  if (fileBreakpoints.has(lineNumber)) {
    fileBreakpoints.delete(lineNumber);
    console.log(`[Debug] Removed breakpoint: ${filePath}:${lineNumber}`);
  } else {
    fileBreakpoints.add(lineNumber);
    console.log(`[Debug] Added breakpoint: ${filePath}:${lineNumber}`);
  }
  
  // Update decorations
  updateBreakpointDecorations();
  
  // Persist to localStorage
  saveBreakpoints();
  
  // Update breakpoints panel if visible
  renderBreakpointsPanel();
}

/**
 * Check if breakpoint exists
 */
function hasBreakpoint(filePath, lineNumber) {
  return debugState.breakpoints.get(filePath)?.has(lineNumber) || false;
}

/**
 * Get all breakpoints for a file
 */
function getFileBreakpoints(filePath) {
  return Array.from(debugState.breakpoints.get(filePath) || []).sort((a, b) => a - b);
}

/**
 * Get all breakpoints
 */
function getAllBreakpoints() {
  const all = [];
  debugState.breakpoints.forEach((lines, file) => {
    lines.forEach(line => {
      all.push({ file, line });
    });
  });
  return all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Clear all breakpoints
 */
function clearAllBreakpoints() {
  debugState.breakpoints.clear();
  updateBreakpointDecorations();
  saveBreakpoints();
  renderBreakpointsPanel();
}

/**
 * Remove all breakpoints for a file
 */
function clearFileBreakpoints(filePath) {
  debugState.breakpoints.delete(filePath);
  updateBreakpointDecorations();
  saveBreakpoints();
  renderBreakpointsPanel();
}

// ============================================
// MONACO DECORATIONS
// ============================================

/**
 * Update breakpoint decorations in all editors
 */
function updateBreakpointDecorations() {
  // Update each pane's editor
  if (typeof state !== 'undefined' && state.panes) {
    state.panes.forEach((pane, paneId) => {
      updatePaneBreakpointDecorations(paneId);
    });
  }
}

/**
 * Update decorations for a specific pane
 */
function updatePaneBreakpointDecorations(paneId) {
  const pane = state.panes?.get(paneId);
  if (!pane?.editor) return;
  
  const filePath = pane.activeFile;
  if (!filePath) {
    // Clear decorations if no file open
    const oldDecorations = debugState.decorations.get(paneId) || [];
    pane.editor.deltaDecorations(oldDecorations, []);
    debugState.decorations.set(paneId, []);
    return;
  }
  
  const breakpoints = getFileBreakpoints(filePath);
  const oldDecorations = debugState.decorations.get(paneId) || [];
  
  // Create new decorations
  const newDecorations = breakpoints.map(line => ({
    range: new monaco.Range(line, 1, line, 1),
    options: {
      isWholeLine: false,
      glyphMarginClassName: 'breakpoint-glyph',
      glyphMarginHoverMessage: { value: `Breakpoint at line ${line}` },
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
    }
  }));
  
  // Add current execution line if debugging
  if (debugState.isPaused && debugState.currentFile === filePath && debugState.currentLine) {
    newDecorations.push({
      range: new monaco.Range(debugState.currentLine, 1, debugState.currentLine, 1),
      options: {
        isWholeLine: true,
        className: 'debug-current-line',
        glyphMarginClassName: 'debug-current-glyph'
      }
    });
  }
  
  const decorationIds = pane.editor.deltaDecorations(oldDecorations, newDecorations);
  debugState.decorations.set(paneId, decorationIds);
}

/**
 * Setup gutter click handler for an editor
 */
function setupBreakpointGutter(editor, paneId) {
  // Handle mouse down on glyph margin
  editor.onMouseDown((e) => {
    // Check if click is in glyph margin (breakpoint area)
    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
      const lineNumber = e.target.position?.lineNumber;
      const pane = state.panes?.get(paneId);
      
      if (lineNumber && pane?.activeFile) {
        toggleBreakpoint(pane.activeFile, lineNumber);
      }
    }
  });
  
  // Also handle line number click as alternative
  editor.onMouseDown((e) => {
    if (e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
      // Only toggle on Ctrl/Cmd+Click to avoid accidental toggles
      if (e.event.ctrlKey || e.event.metaKey) {
        const lineNumber = e.target.position?.lineNumber;
        const pane = state.panes?.get(paneId);
        
        if (lineNumber && pane?.activeFile) {
          toggleBreakpoint(pane.activeFile, lineNumber);
        }
      }
    }
  });
}

// ============================================
// PERSISTENCE
// ============================================

/**
 * Save breakpoints to localStorage
 */
function saveBreakpoints() {
  const data = {};
  debugState.breakpoints.forEach((lines, file) => {
    if (lines.size > 0) {
      data[file] = Array.from(lines);
    }
  });
  localStorage.setItem('clawd-ide-breakpoints', JSON.stringify(data));
}

/**
 * Load breakpoints from localStorage
 */
function loadBreakpoints() {
  try {
    const data = JSON.parse(localStorage.getItem('clawd-ide-breakpoints') || '{}');
    Object.entries(data).forEach(([file, lines]) => {
      debugState.breakpoints.set(file, new Set(lines));
    });
    console.log(`[Debug] Loaded ${getAllBreakpoints().length} breakpoints`);
  } catch (e) {
    console.error('[Debug] Failed to load breakpoints:', e);
  }
}

// ============================================
// BREAKPOINTS PANEL UI
// ============================================

/**
 * Render the breakpoints panel
 */
function renderBreakpointsPanel() {
  const container = document.getElementById('breakpointsList');
  if (!container) return;
  
  const breakpoints = getAllBreakpoints();
  
  if (breakpoints.length === 0) {
    container.innerHTML = `
      <div class="breakpoints-empty">
        <p>No breakpoints set</p>
        <p class="hint">Click in the gutter to add breakpoints</p>
      </div>
    `;
    return;
  }
  
  // Group by file
  const byFile = {};
  breakpoints.forEach(bp => {
    if (!byFile[bp.file]) byFile[bp.file] = [];
    byFile[bp.file].push(bp.line);
  });
  
  let html = '';
  Object.entries(byFile).forEach(([file, lines]) => {
    const fileName = file.split('/').pop();
    const relativePath = file.replace(state.workspace + '/', '');
    
    html += `
      <div class="breakpoints-file">
        <div class="breakpoints-file-header">
          <span class="breakpoints-file-name" title="${relativePath}">${fileName}</span>
          <button class="breakpoints-clear-file" onclick="clearFileBreakpoints('${file.replace(/'/g, "\\'")}')" title="Remove all">×</button>
        </div>
        <div class="breakpoints-lines">
          ${lines.map(line => `
            <div class="breakpoint-item" onclick="goToBreakpoint('${file.replace(/'/g, "\\'")}', ${line})">
              <span class="breakpoint-dot"></span>
              <span class="breakpoint-line">Line ${line}</span>
              <button class="breakpoint-remove" onclick="event.stopPropagation(); toggleBreakpoint('${file.replace(/'/g, "\\'")}', ${line})">×</button>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  });
  
  container.innerHTML = html;
}

/**
 * Go to a breakpoint location
 */
function goToBreakpoint(filePath, lineNumber) {
  if (typeof openFile === 'function') {
    openFile(filePath, false).then(() => {
      setTimeout(() => {
        if (state.editor) {
          state.editor.revealLineInCenter(lineNumber);
          state.editor.setPosition({ lineNumber, column: 1 });
          state.editor.focus();
        }
      }, 100);
    });
  }
}

// ============================================
// DEBUG SESSION CONTROL (Phase 2)
// ============================================

/**
 * Start a debug session
 */
async function startDebugging(config) {
  if (debugState.isDebugging) {
    showNotification('Debug session already active', 'warning');
    return;
  }
  
  // If no config provided, show launch dialog
  if (!config) {
    showLaunchDialog();
    return;
  }
  
  console.log('[Debug] Starting debug session...', config);
  updateDebugStatus('Starting...');
  
  try {
    const res = await fetch('/api/debug/launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    
    const data = await res.json();
    
    if (data.error) {
      throw new Error(data.error);
    }
    
    debugState.isDebugging = true;
    debugState.isPaused = true; // Starts paused (--inspect-brk)
    updateDebugUI();
    updateDebugStatus('Paused on entry');
    showNotification('Debug session started', 'success');
    
    // Sync breakpoints to debug session
    syncBreakpointsToSession();
    
  } catch (err) {
    console.error('[Debug] Launch failed:', err);
    showNotification(`Debug failed: ${err.message}`, 'error');
    updateDebugStatus('Ready');
  }
}

/**
 * Show launch configuration dialog
 */
function showLaunchDialog() {
  const dialog = document.createElement('div');
  dialog.className = 'debug-launch-dialog';
  dialog.innerHTML = `
    <div class="debug-launch-content">
      <h3>🐛 Start Debugging</h3>
      <div class="debug-launch-form">
        <label>
          <span>Program (JS/TS file):</span>
          <input type="text" id="debugProgram" placeholder="e.g., src/index.js or server.js" />
        </label>
        <label>
          <span>Working Directory (optional):</span>
          <input type="text" id="debugCwd" placeholder="Leave empty for workspace root" />
        </label>
        <label>
          <span>Arguments (optional):</span>
          <input type="text" id="debugArgs" placeholder="e.g., --port 3000" />
        </label>
      </div>
      <div class="debug-launch-actions">
        <button onclick="closeLaunchDialog()">Cancel</button>
        <button class="primary" onclick="launchFromDialog()">▶ Start</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(dialog);
  document.getElementById('debugProgram').focus();
}

function closeLaunchDialog() {
  const dialog = document.querySelector('.debug-launch-dialog');
  if (dialog) dialog.remove();
}

function launchFromDialog() {
  const program = document.getElementById('debugProgram').value.trim();
  const cwd = document.getElementById('debugCwd').value.trim();
  const argsStr = document.getElementById('debugArgs').value.trim();
  
  if (!program) {
    showNotification('Please enter a program to debug', 'error');
    return;
  }
  
  const args = argsStr ? argsStr.split(/\s+/) : [];
  
  closeLaunchDialog();
  startDebugging({ type: 'node', program, cwd: cwd || null, args });
}

/**
 * Stop debug session
 */
async function stopDebugging() {
  if (!debugState.isDebugging) return;
  
  console.log('[Debug] Stopping debug session');
  
  try {
    await fetch('/api/debug/stop', { method: 'POST' });
  } catch (err) {
    console.error('[Debug] Stop error:', err);
  }
  
  debugState.isDebugging = false;
  debugState.isPaused = false;
  debugState.currentFile = null;
  debugState.currentLine = null;
  debugState.callStack = [];
  debugState.variables = [];
  
  updateDebugUI();
  updateBreakpointDecorations();
  updateDebugStatus('Ready');
  renderCallStack();
  renderVariables();
}

/**
 * Pause execution
 */
async function pauseDebugging() {
  if (!debugState.isDebugging) return;
  
  try {
    await fetch('/api/debug/pause', { method: 'POST' });
  } catch (err) {
    console.error('[Debug] Pause error:', err);
  }
}

/**
 * Continue execution
 */
async function continueDebugging() {
  if (!debugState.isDebugging) return;
  
  debugState.isPaused = false;
  updateDebugStatus('Running...');
  updateDebugUI();
  
  try {
    await fetch('/api/debug/continue', { method: 'POST' });
  } catch (err) {
    console.error('[Debug] Continue error:', err);
  }
}

/**
 * Step over (next line)
 */
async function stepOver() {
  if (!debugState.isDebugging || !debugState.isPaused) return;
  
  try {
    await fetch('/api/debug/stepOver', { method: 'POST' });
  } catch (err) {
    console.error('[Debug] Step over error:', err);
  }
}

/**
 * Step into function
 */
async function stepInto() {
  if (!debugState.isDebugging || !debugState.isPaused) return;
  
  try {
    await fetch('/api/debug/stepIn', { method: 'POST' });
  } catch (err) {
    console.error('[Debug] Step into error:', err);
  }
}

/**
 * Step out of function
 */
async function stepOut() {
  if (!debugState.isDebugging || !debugState.isPaused) return;
  
  try {
    await fetch('/api/debug/stepOut', { method: 'POST' });
  } catch (err) {
    console.error('[Debug] Step out error:', err);
  }
}

/**
 * Sync breakpoints to active debug session
 */
async function syncBreakpointsToSession() {
  for (const [file, lines] of debugState.breakpoints) {
    try {
      await fetch('/api/debug/breakpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, lines: Array.from(lines) })
      });
    } catch (err) {
      console.error(`[Debug] Failed to sync breakpoints for ${file}:`, err);
    }
  }
}

/**
 * Handle debug events from WebSocket
 */
function handleDebugEvent(event, data) {
  console.log('[Debug] Event:', event, data);
  
  switch (event) {
    case 'stopped':
      debugState.isPaused = true;
      updateDebugStatus(`Paused: ${data.reason || 'breakpoint'}`);
      updateDebugUI();
      break;
      
    case 'continued':
      debugState.isPaused = false;
      updateDebugStatus('Running...');
      updateDebugUI();
      break;
      
    case 'terminated':
      debugState.isDebugging = false;
      debugState.isPaused = false;
      debugState.currentFile = null;
      debugState.currentLine = null;
      updateDebugUI();
      updateBreakpointDecorations();
      updateDebugStatus('Session ended');
      showNotification('Debug session ended', 'info');
      break;
      
    case 'output':
      // Send to terminal or debug console
      if (data.output && typeof handleTerminalOutput === 'function') {
        // Append to debug output (could create separate debug console)
        console.log('[Debug Output]', data.output);
      }
      break;
      
    case 'stackTrace':
      debugState.callStack = data.frames || [];
      debugState.selectedFrameId = 0; // Select top frame
      renderCallStack();
      
      // Jump to current location
      if (data.frames && data.frames.length > 0) {
        const topFrame = data.frames[0];
        if (topFrame.source?.path) {
          debugState.currentFile = topFrame.source.path;
          debugState.currentLine = topFrame.line;
          
          // Open file and show current line
          jumpToDebugLocation(topFrame.source.path, topFrame.line);
          updateBreakpointDecorations();
        }
        
        // Fetch scopes and variables for top frame
        fetchScopesForFrame(0);
        evaluateWatchExpressions();
      }
      break;
  }
}

/**
 * Jump to debug location in editor
 */
async function jumpToDebugLocation(filePath, line) {
  // Convert file:// URL to path
  const cleanPath = filePath.replace(/^file:\/\//, '');
  
  if (typeof openFile === 'function') {
    await openFile(cleanPath, false);
    setTimeout(() => {
      if (state.editor) {
        state.editor.revealLineInCenter(line);
        state.editor.setPosition({ lineNumber: line, column: 1 });
      }
    }, 100);
  }
}

/**
 * Update debug UI state (enable/disable buttons)
 */
function updateDebugUI() {
  const isActive = debugState.isDebugging;
  const isPaused = debugState.isPaused;
  
  // Update toolbar buttons
  const toolbar = document.querySelector('.debug-toolbar');
  if (toolbar) {
    const buttons = toolbar.querySelectorAll('button');
    buttons.forEach(btn => {
      const action = btn.getAttribute('onclick');
      if (!action) return;
      
      if (action.includes('startDebugging')) {
        btn.disabled = isActive;
      } else if (action.includes('stopDebugging')) {
        btn.disabled = !isActive;
      } else if (action.includes('pauseDebugging')) {
        btn.disabled = !isActive || isPaused;
      } else if (action.includes('continueDebugging')) {
        btn.disabled = !isActive || !isPaused;
      } else if (action.includes('stepOver') || action.includes('stepInto') || action.includes('stepOut')) {
        btn.disabled = !isActive || !isPaused;
      }
    });
  }
}

/**
 * Update debug status text
 */
function updateDebugStatus(text) {
  const status = document.getElementById('debugStatus');
  if (status) status.textContent = text;
}

/**
 * Render call stack panel
 */
function renderCallStack() {
  const sections = document.querySelectorAll('#panel-debug .debug-section');
  const callStackSection = sections[2]; // Third section (after breakpoints, variables)
  if (!callStackSection) return;
  
  const content = callStackSection.querySelector('.debug-section-content');
  if (!content) return;
  
  if (!debugState.callStack || debugState.callStack.length === 0) {
    content.innerHTML = '<div class="debug-placeholder">No call stack</div>';
    return;
  }
  
  let html = '<div class="call-stack-list">';
  debugState.callStack.forEach((frame, index) => {
    const fileName = frame.source?.name || 'unknown';
    const isSelected = index === debugState.selectedFrameId;
    html += `
      <div class="call-stack-frame ${isSelected ? 'selected' : ''}" 
           onclick="selectStackFrame(${index})">
        <span class="frame-icon">${isSelected ? '▶' : ' '}</span>
        <span class="frame-name">${escapeHtml(frame.name)}</span>
        <span class="frame-location">${escapeHtml(fileName)}:${frame.line}</span>
      </div>
    `;
  });
  html += '</div>';
  
  content.innerHTML = html;
}

/**
 * Select a stack frame
 */
async function selectStackFrame(index) {
  const frame = debugState.callStack[index];
  if (!frame?.source?.path) return;
  
  debugState.selectedFrameId = index;
  
  // Update call stack UI to show selection
  renderCallStack();
  
  // Jump to the frame's location
  jumpToDebugLocation(frame.source.path, frame.line);
  
  // Fetch scopes and variables for this frame
  await fetchScopesForFrame(index);
  await evaluateWatchExpressions();
}

/**
 * Fetch scopes for the current frame
 */
async function fetchScopesForFrame(frameId) {
  try {
    const res = await fetch(`/api/debug/scopes/${frameId}`);
    const data = await res.json();
    
    if (data.error) {
      console.error('[Debug] Fetch scopes error:', data.error);
      return;
    }
    
    debugState.scopes = data.scopes || [];
    debugState.variables.clear();
    
    // Auto-fetch local scope variables (non-expensive)
    for (const scope of debugState.scopes) {
      if (!scope.expensive && scope.objectId) {
        await fetchVariablesForScope(scope.objectId);
      }
    }
    
    renderVariables();
  } catch (err) {
    console.error('[Debug] Failed to fetch scopes:', err);
  }
}

/**
 * Fetch variables for a scope or object
 */
async function fetchVariablesForScope(objectId) {
  try {
    const res = await fetch(`/api/debug/variables/${encodeURIComponent(objectId)}`);
    const data = await res.json();
    
    if (data.error) {
      console.error('[Debug] Fetch variables error:', data.error);
      return [];
    }
    
    debugState.variables.set(objectId, data.variables || []);
    return data.variables || [];
  } catch (err) {
    console.error('[Debug] Failed to fetch variables:', err);
    return [];
  }
}

/**
 * Toggle variable expansion
 */
async function toggleVarExpansion(objectId, element) {
  if (debugState.expandedVars.has(objectId)) {
    debugState.expandedVars.delete(objectId);
    renderVariables();
  } else {
    // Fetch children if not cached
    if (!debugState.variables.has(objectId)) {
      element.classList.add('loading');
      await fetchVariablesForScope(objectId);
      element.classList.remove('loading');
    }
    debugState.expandedVars.add(objectId);
    renderVariables();
  }
}

/**
 * Render a single variable with its children
 */
function renderVariable(v, depth = 0) {
  const hasChildren = v.variablesReference && v.variablesReference !== 0;
  const isExpanded = debugState.expandedVars.has(v.variablesReference);
  const indent = depth * 16;
  
  let typeClass = 'var-' + (v.type || 'unknown');
  let valueDisplay = v.value;
  
  // Truncate long values
  if (valueDisplay && valueDisplay.length > 50) {
    valueDisplay = valueDisplay.substring(0, 47) + '...';
  }
  
  let html = `
    <div class="variable-item ${hasChildren ? 'expandable' : ''}" 
         style="padding-left: ${indent + 8}px"
         ${hasChildren ? `onclick="toggleVarExpansion('${v.variablesReference}', this)"` : ''}>
      ${hasChildren ? `<span class="var-arrow">${isExpanded ? '▼' : '▶'}</span>` : '<span class="var-spacer"></span>'}
      <span class="var-name">${escapeHtml(v.name)}</span>
      <span class="var-separator">:</span>
      <span class="var-value ${typeClass}" title="${escapeHtml(v.value || '')}">${escapeHtml(valueDisplay || 'undefined')}</span>
    </div>
  `;
  
  // Render children if expanded
  if (hasChildren && isExpanded) {
    const children = debugState.variables.get(v.variablesReference) || [];
    children.forEach(child => {
      html += renderVariable(child, depth + 1);
    });
  }
  
  return html;
}

/**
 * Render variables panel
 */
function renderVariables() {
  const sections = document.querySelectorAll('#panel-debug .debug-section');
  const varsSection = sections[1];
  if (!varsSection) return;
  
  const content = varsSection.querySelector('.debug-section-content');
  if (!content) return;
  
  if (!debugState.isPaused) {
    content.innerHTML = '<div class="debug-placeholder">Not paused</div>';
    return;
  }
  
  if (debugState.scopes.length === 0) {
    content.innerHTML = '<div class="debug-placeholder">No variables</div>';
    return;
  }
  
  let html = '<div class="variables-list">';
  
  for (const scope of debugState.scopes) {
    // Skip global scope by default (too large)
    if (scope.type === 'global') continue;
    
    html += `<div class="scope-header">${scope.name}</div>`;
    
    const vars = debugState.variables.get(scope.objectId) || [];
    if (vars.length === 0) {
      html += '<div class="debug-placeholder" style="padding-left: 16px">Empty scope</div>';
    } else {
      vars.forEach(v => {
        html += renderVariable(v, 0);
      });
    }
  }
  
  html += '</div>';
  content.innerHTML = html;
}

/**
 * Render watch expressions panel
 */
function renderWatchExpressions() {
  const sections = document.querySelectorAll('#panel-debug .debug-section');
  const watchSection = sections[3]; // Fourth section: Watch
  if (!watchSection) return;
  
  const content = watchSection.querySelector('.debug-section-content');
  if (!content) return;
  
  let html = `
    <div class="watch-input-wrapper">
      <input type="text" id="watchExprInput" placeholder="Add expression..." 
             onkeydown="if(event.key==='Enter') addWatchExpression(this.value)">
      <button onclick="addWatchExpression(document.getElementById('watchExprInput').value)">+</button>
    </div>
    <div class="watch-list">
  `;
  
  if (debugState.watchExpressions.length === 0) {
    html += '<div class="debug-placeholder">No watch expressions</div>';
  } else {
    debugState.watchExpressions.forEach((expr, index) => {
      html += `
        <div class="watch-item">
          <span class="watch-expr">${escapeHtml(expr.expression)}</span>
          <span class="watch-value ${expr.error ? 'watch-error' : ''}">${escapeHtml(expr.value || 'undefined')}</span>
          <button class="watch-remove" onclick="removeWatchExpression(${index})">×</button>
        </div>
      `;
    });
  }
  
  html += '</div>';
  content.innerHTML = html;
}

/**
 * Add a watch expression
 */
async function addWatchExpression(expression) {
  if (!expression || !expression.trim()) return;
  
  const expr = expression.trim();
  
  // Check if already watching
  if (debugState.watchExpressions.find(w => w.expression === expr)) return;
  
  debugState.watchExpressions.push({ expression: expr, value: 'evaluating...' });
  renderWatchExpressions();
  
  // Evaluate if debugging
  await evaluateWatchExpressions();
  
  // Clear input
  const input = document.getElementById('watchExprInput');
  if (input) input.value = '';
  
  // Save to localStorage
  saveWatchExpressions();
}

/**
 * Remove a watch expression
 */
function removeWatchExpression(index) {
  debugState.watchExpressions.splice(index, 1);
  renderWatchExpressions();
  saveWatchExpressions();
}

/**
 * Evaluate all watch expressions
 */
async function evaluateWatchExpressions() {
  if (!debugState.isDebugging || !debugState.isPaused) {
    debugState.watchExpressions.forEach(w => {
      w.value = '<not available>';
      w.error = true;
    });
    renderWatchExpressions();
    return;
  }
  
  for (const watch of debugState.watchExpressions) {
    try {
      const res = await fetch('/api/debug/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          expression: watch.expression, 
          frameId: debugState.selectedFrameId 
        })
      });
      
      const data = await res.json();
      watch.value = data.result || 'undefined';
      watch.error = data.result?.startsWith('Error:');
    } catch (err) {
      watch.value = `Error: ${err.message}`;
      watch.error = true;
    }
  }
  
  renderWatchExpressions();
}

/**
 * Save watch expressions to localStorage
 */
function saveWatchExpressions() {
  const exprs = debugState.watchExpressions.map(w => w.expression);
  localStorage.setItem('clawd-ide-watch', JSON.stringify(exprs));
}

/**
 * Load watch expressions from localStorage
 */
function loadWatchExpressions() {
  try {
    const exprs = JSON.parse(localStorage.getItem('clawd-ide-watch') || '[]');
    debugState.watchExpressions = exprs.map(e => ({ expression: e, value: '<not available>' }));
  } catch (e) {
    console.error('[Debug] Failed to load watch expressions:', e);
  }
}

/**
 * Escape HTML for safe rendering
 */
function escapeHtml(text) {
  if (typeof text !== 'string') return String(text);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============================================
// INITIALIZATION
// ============================================

function initDebugger() {
  // Load saved breakpoints
  loadBreakpoints();
  
  // Load saved watch expressions
  loadWatchExpressions();
  
  // Initial render of panels
  renderBreakpointsPanel();
  renderWatchExpressions();
  
  console.log('[Debug] Debugger module initialized');
}

// ============================================
// EXPORTS
// ============================================

window.debugState = debugState;
window.toggleBreakpoint = toggleBreakpoint;
window.hasBreakpoint = hasBreakpoint;
window.getFileBreakpoints = getFileBreakpoints;
window.getAllBreakpoints = getAllBreakpoints;
window.clearAllBreakpoints = clearAllBreakpoints;
window.clearFileBreakpoints = clearFileBreakpoints;
window.updateBreakpointDecorations = updateBreakpointDecorations;
window.updatePaneBreakpointDecorations = updatePaneBreakpointDecorations;
window.setupBreakpointGutter = setupBreakpointGutter;
window.renderBreakpointsPanel = renderBreakpointsPanel;
window.goToBreakpoint = goToBreakpoint;
window.initDebugger = initDebugger;
// Debug controls (Phase 2)
window.startDebugging = startDebugging;
window.stopDebugging = stopDebugging;
window.pauseDebugging = pauseDebugging;
window.continueDebugging = continueDebugging;
window.stepOver = stepOver;
window.stepInto = stepInto;
window.stepOut = stepOut;
// Launch dialog
window.showLaunchDialog = showLaunchDialog;
window.closeLaunchDialog = closeLaunchDialog;
window.launchFromDialog = launchFromDialog;
// Debug event handling
window.handleDebugEvent = handleDebugEvent;
window.selectStackFrame = selectStackFrame;
window.renderCallStack = renderCallStack;
// Variables (Phase 3)
window.renderVariables = renderVariables;
window.fetchScopesForFrame = fetchScopesForFrame;
window.fetchVariablesForScope = fetchVariablesForScope;
window.toggleVarExpansion = toggleVarExpansion;
// Watch expressions (Phase 3)
window.renderWatchExpressions = renderWatchExpressions;
window.addWatchExpression = addWatchExpression;
window.removeWatchExpression = removeWatchExpression;
window.evaluateWatchExpressions = evaluateWatchExpressions;
