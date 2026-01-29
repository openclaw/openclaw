// ============================================
// TERMINAL MODULE - Multi-Terminal Support
// ============================================
// Depends on: state (global), Terminal, FitAddon, SearchAddon, WebLinksAddon

const terminalState = {
  terminals: new Map(), // id -> { terminal, fitAddon, searchAddon, name, paneId }
  activeTerminalId: null,
  nextId: 1,
  // Split pane support
  panes: new Map(), // paneId -> { terminalIds: [], activeTerminalId }
  activePaneId: 'main',
  nextPaneId: 1,
  splitMode: 'none', // 'none' | 'horizontal' | 'vertical'
};

function createTerminal(name = null, profile = 'zsh', command = null) {
  const id = terminalState.nextId++;
  const terminalName = name || `Terminal ${id}`;
  
  const terminal = new Terminal({
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#4ade80',
      selection: '#264f78',
      black: '#000000',
      red: '#f44747',
      green: '#4ade80',
      yellow: '#cca700',
      blue: '#3794ff',
      magenta: '#bc89bd',
      cyan: '#89d4eb',
      white: '#e5e5e5',
    },
    fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
  });
  
  const fitAddon = new FitAddon.FitAddon();
  const searchAddon = new SearchAddon.SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon());
  
  // Create container for this terminal
  const container = document.createElement('div');
  container.id = `terminal-${id}`;
  container.className = 'terminal-instance';
  container.style.display = 'none';
  document.getElementById('terminalInstances').appendChild(container);
  
  terminal.open(container);
  fitAddon.fit();
  
  // Send input to server with terminal ID
  terminal.onData((data) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'terminal:input', id, data }));
    }
  });
  
  // Handle resize
  terminal.onResize(({ cols, rows }) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'terminal:resize', id, cols, rows }));
    }
  });
  
  terminalState.terminals.set(id, {
    terminal,
    fitAddon,
    searchAddon,
    name: terminalName,
    container,
    profile,
  });
  
  // Start PTY session for this terminal
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    fitAddon.fit();
    const dims = fitAddon.proposeDimensions();
    state.ws.send(JSON.stringify({ 
      type: 'terminal:start',
      id,
      cols: dims?.cols || 80,
      rows: dims?.rows || 24,
      command: command // Custom shell/command
    }));
  }
  
  renderTerminalTabs();
  switchToTerminal(id);
  
  return id;
}

function switchToTerminal(id) {
  const entry = terminalState.terminals.get(id);
  if (!entry) return;
  
  // Hide all terminals
  terminalState.terminals.forEach((t, tid) => {
    t.container.style.display = tid === id ? 'block' : 'none';
  });
  
  terminalState.activeTerminalId = id;
  
  // Update global state for compatibility
  state.terminal = entry.terminal;
  state.terminalFitAddon = entry.fitAddon;
  state.terminalSearchAddon = entry.searchAddon;
  
  // Fit the active terminal
  setTimeout(() => entry.fitAddon.fit(), 10);
  
  renderTerminalTabs();
}

function closeTerminal(id) {
  const entry = terminalState.terminals.get(id);
  if (!entry) return;
  
  // Kill the PTY on server
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'terminal:kill', id }));
  }
  
  // Dispose terminal
  entry.terminal.dispose();
  entry.container.remove();
  terminalState.terminals.delete(id);
  
  // Switch to another terminal or create new one
  if (terminalState.terminals.size === 0) {
    createTerminal();
  } else {
    const nextId = terminalState.terminals.keys().next().value;
    switchToTerminal(nextId);
  }
  
  renderTerminalTabs();
}

function renameTerminal(id) {
  const entry = terminalState.terminals.get(id);
  if (!entry) return;
  
  const newName = prompt('Terminal name:', entry.name);
  if (newName) {
    entry.name = newName;
    renderTerminalTabs();
  }
}

// Terminal profiles
const terminalProfiles = [
  { id: 'zsh', name: 'zsh', command: 'zsh', icon: '🐚' },
  { id: 'bash', name: 'bash', command: 'bash', icon: '💲' },
  { id: 'node', name: 'Node REPL', command: 'node', icon: '🟢' },
  { id: 'python', name: 'Python', command: 'python3', icon: '🐍' },
  { id: 'bun', name: 'Bun REPL', command: 'bun repl', icon: '🍞' },
];

function renderTerminalTabs() {
  const tabBar = document.getElementById('terminalTabs');
  if (!tabBar) return;
  
  let html = '';
  terminalState.terminals.forEach((entry, id) => {
    const isActive = id === terminalState.activeTerminalId;
    const profile = terminalProfiles.find(p => p.id === entry.profile) || {};
    html += `
      <div class="terminal-tab ${isActive ? 'active' : ''}" 
           onclick="switchToTerminal(${id})"
           ondblclick="renameTerminal(${id})">
        <span class="terminal-tab-icon">${profile.icon || '⬛'}</span>
        <span class="terminal-tab-name">${entry.name}</span>
        ${terminalState.terminals.size > 1 ? `
          <button class="terminal-tab-close" onclick="event.stopPropagation(); closeTerminal(${id})">×</button>
        ` : ''}
      </div>
    `;
  });
  
  html += `
    <div class="terminal-actions">
      <button class="terminal-quick-cmd" onclick="showQuickCommands()" title="Quick Commands (Cmd+Shift+P)">⚡</button>
      <div class="terminal-profile-dropdown">
        <button class="terminal-tab-add" onclick="createTerminal()" title="New Terminal (default shell)">+</button>
        <button class="terminal-profile-toggle" onclick="toggleProfileMenu(event)" title="Choose shell">▾</button>
        <div class="terminal-profile-menu" id="terminalProfileMenu">
          ${terminalProfiles.map(p => `
            <div class="terminal-profile-item" onclick="createTerminalWithProfile('${p.id}')">
              <span class="profile-icon">${p.icon}</span>
              <span class="profile-name">${p.name}</span>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
  
  tabBar.innerHTML = html;
}

function toggleProfileMenu(event) {
  event.stopPropagation();
  const menu = document.getElementById('terminalProfileMenu');
  menu.classList.toggle('visible');
  
  // Close on click outside
  const closeMenu = (e) => {
    if (!menu.contains(e.target)) {
      menu.classList.remove('visible');
      document.removeEventListener('click', closeMenu);
    }
  };
  setTimeout(() => document.addEventListener('click', closeMenu), 10);
}

function createTerminalWithProfile(profileId) {
  const profile = terminalProfiles.find(p => p.id === profileId);
  if (!profile) return;
  
  // Close the menu
  document.getElementById('terminalProfileMenu')?.classList.remove('visible');
  
  // Create terminal with profile
  createTerminal(profile.name, profile.id, profile.command);
}

// Quick commands for terminal
const quickCommands = [
  { name: 'npm install', cmd: 'npm install\n', icon: '📦' },
  { name: 'npm run dev', cmd: 'npm run dev\n', icon: '▶️' },
  { name: 'npm run build', cmd: 'npm run build\n', icon: '🔨' },
  { name: 'npm test', cmd: 'npm test\n', icon: '🧪' },
  { name: 'git status', cmd: 'git status\n', icon: '📊' },
  { name: 'git pull', cmd: 'git pull\n', icon: '⬇️' },
  { name: 'git push', cmd: 'git push\n', icon: '⬆️' },
  { name: 'clear', cmd: 'clear\n', icon: '🧹' },
];

function showQuickCommands() {
  // Create quick commands dropdown
  let menu = document.getElementById('quickCommandsMenu');
  if (menu) {
    menu.classList.toggle('visible');
    return;
  }
  
  menu = document.createElement('div');
  menu.id = 'quickCommandsMenu';
  menu.className = 'quick-commands-menu visible';
  menu.innerHTML = `
    <div class="quick-commands-header">Quick Commands</div>
    ${quickCommands.map((c, i) => `
      <div class="quick-command-item" onclick="runQuickCommand(${i})">
        <span class="quick-cmd-icon">${c.icon}</span>
        <span class="quick-cmd-name">${c.name}</span>
      </div>
    `).join('')}
    <div class="quick-commands-footer">
      <input type="text" id="customCommandInput" placeholder="Custom command..." 
             onkeydown="if(event.key==='Enter') runCustomCommand()">
    </div>
  `;
  
  const terminalContainer = document.getElementById('terminalContainer');
  terminalContainer.appendChild(menu);
  
  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', closeQuickCommands);
  }, 10);
}

function closeQuickCommands(e) {
  const menu = document.getElementById('quickCommandsMenu');
  if (menu && !menu.contains(e?.target)) {
    menu.remove();
    document.removeEventListener('click', closeQuickCommands);
  }
}

function runQuickCommand(index) {
  const cmd = quickCommands[index];
  if (!cmd) return;
  
  // Send to active terminal
  const entry = terminalState.terminals.get(terminalState.activeTerminalId);
  if (entry && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ 
      type: 'terminal:input', 
      id: terminalState.activeTerminalId,
      data: cmd.cmd 
    }));
  }
  
  closeQuickCommands();
}

function runCustomCommand() {
  const input = document.getElementById('customCommandInput');
  const cmd = input?.value.trim();
  if (!cmd) return;
  
  const entry = terminalState.terminals.get(terminalState.activeTerminalId);
  if (entry && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ 
      type: 'terminal:input', 
      id: terminalState.activeTerminalId,
      data: cmd + '\n'
    }));
  }
  
  closeQuickCommands();
}

function initTerminal() {
  // Create the terminal tabs bar and instances container
  const container = document.getElementById('terminal');
  if (!container) return;
  
  // Wrap existing content
  container.innerHTML = `
    <div id="terminalTabs" class="terminal-tabs"></div>
    <div id="terminalInstances" class="terminal-instances"></div>
  `;
  
  // Setup resize observer
  new ResizeObserver(() => {
    const entry = terminalState.terminals.get(terminalState.activeTerminalId);
    if (entry?.fitAddon) {
      entry.fitAddon.fit();
    }
  }).observe(container);
  
  // Create first terminal
  createTerminal('zsh');
}

function startTerminal() {
  // For compatibility - starts the active terminal
  const id = terminalState.activeTerminalId;
  if (!id) return;
  
  const entry = terminalState.terminals.get(id);
  if (entry && state.ws && state.ws.readyState === WebSocket.OPEN) {
    entry.fitAddon.fit();
    const dims = entry.fitAddon.proposeDimensions();
    state.ws.send(JSON.stringify({ 
      type: 'terminal:start',
      id,
      cols: dims?.cols || 80,
      rows: dims?.rows || 24
    }));
  }
}

function toggleTerminal() {
  const container = document.getElementById('terminalContainer');
  container.classList.toggle('collapsed');
  if (!container.classList.contains('collapsed')) {
    const entry = terminalState.terminals.get(terminalState.activeTerminalId);
    if (entry?.fitAddon) {
      setTimeout(() => entry.fitAddon.fit(), 50);
    }
  }
}

function clearTerminal() {
  const entry = terminalState.terminals.get(terminalState.activeTerminalId);
  if (entry?.terminal) {
    entry.terminal.clear();
  }
}

// Handle terminal output from server (with ID support)
function handleTerminalOutput(id, data) {
  const entry = terminalState.terminals.get(id);
  if (entry?.terminal) {
    entry.terminal.write(data);
  } else if (!id && state.terminal) {
    // Legacy support for messages without ID
    state.terminal.write(data);
  }
}

// ============================================
// SPLIT TERMINAL SUPPORT
// ============================================

function splitTerminal(direction = 'horizontal') {
  const container = document.getElementById('terminalInstances');
  if (!container) return;
  
  // If already split in the same direction, just add a pane
  // If split differently, we'd need to handle that (for now, just toggle)
  if (terminalState.splitMode === direction) {
    // Already split in this direction, unsplit
    unsplitTerminal();
    return;
  }
  
  if (terminalState.splitMode !== 'none') {
    // Different split mode, unsplit first
    unsplitTerminal();
  }
  
  terminalState.splitMode = direction;
  
  // Initialize panes if needed
  if (terminalState.panes.size === 0) {
    // Move existing terminals to main pane
    terminalState.panes.set('main', {
      terminalIds: Array.from(terminalState.terminals.keys()),
      activeTerminalId: terminalState.activeTerminalId
    });
  }
  
  // Create new pane
  const newPaneId = `pane-${terminalState.nextPaneId++}`;
  terminalState.panes.set(newPaneId, {
    terminalIds: [],
    activeTerminalId: null
  });
  
  // Restructure DOM
  renderSplitTerminals();
  
  // Create a terminal in the new pane
  createTerminalInPane('zsh', null, newPaneId);
  
  // Focus the new pane
  terminalState.activePaneId = newPaneId;
}

function unsplitTerminal() {
  if (terminalState.splitMode === 'none') return;
  
  // Collect all terminals from all panes
  const allTerminalIds = [];
  terminalState.panes.forEach(pane => {
    allTerminalIds.push(...pane.terminalIds);
  });
  
  // Reset to single pane
  terminalState.splitMode = 'none';
  terminalState.panes.clear();
  terminalState.panes.set('main', {
    terminalIds: allTerminalIds,
    activeTerminalId: terminalState.activeTerminalId
  });
  terminalState.activePaneId = 'main';
  
  // Reassign paneId for all terminals
  allTerminalIds.forEach(id => {
    const entry = terminalState.terminals.get(id);
    if (entry) entry.paneId = 'main';
  });
  
  renderSplitTerminals();
}

function createTerminalInPane(profile = 'zsh', command = null, paneId = null) {
  const targetPaneId = paneId || terminalState.activePaneId || 'main';
  const id = terminalState.nextId++;
  const terminalName = `Terminal ${id}`;
  
  const terminal = new Terminal({
    theme: {
      background: '#1e1e1e',
      foreground: '#cccccc',
      cursor: '#4ade80',
      selection: '#264f78',
      black: '#000000',
      red: '#f44747',
      green: '#4ade80',
      yellow: '#cca700',
      blue: '#3794ff',
      magenta: '#bc89bd',
      cyan: '#89d4eb',
      white: '#e5e5e5',
    },
    fontFamily: "'SF Mono', 'Fira Code', Menlo, monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
  });
  
  const fitAddon = new FitAddon.FitAddon();
  const searchAddon = new SearchAddon.SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon());
  
  // Find the instances container for this pane
  const instancesContainer = document.getElementById(`terminalInstances-${targetPaneId}`) 
    || document.getElementById('terminalInstances');
  
  const container = document.createElement('div');
  container.id = `terminal-${id}`;
  container.className = 'terminal-instance';
  container.style.display = 'none';
  instancesContainer.appendChild(container);
  
  terminal.open(container);
  fitAddon.fit();
  
  terminal.onData((data) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'terminal:input', id, data }));
    }
  });
  
  terminal.onResize(({ cols, rows }) => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'terminal:resize', id, cols, rows }));
    }
  });
  
  terminalState.terminals.set(id, {
    terminal,
    fitAddon,
    searchAddon,
    name: terminalName,
    container,
    profile,
    paneId: targetPaneId
  });
  
  // Add to pane
  const pane = terminalState.panes.get(targetPaneId);
  if (pane) {
    pane.terminalIds.push(id);
    pane.activeTerminalId = id;
  }
  
  // Start PTY
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    fitAddon.fit();
    const dims = fitAddon.proposeDimensions();
    state.ws.send(JSON.stringify({ 
      type: 'terminal:start',
      id,
      cols: dims?.cols || 80,
      rows: dims?.rows || 24,
      command
    }));
  }
  
  renderTerminalTabsForPane(targetPaneId);
  switchToTerminalInPane(id, targetPaneId);
  
  return id;
}

function switchToTerminalInPane(terminalId, paneId) {
  const pane = terminalState.panes.get(paneId);
  if (!pane) return;
  
  // Hide all terminals in this pane
  pane.terminalIds.forEach(id => {
    const entry = terminalState.terminals.get(id);
    if (entry) {
      entry.container.style.display = id === terminalId ? 'block' : 'none';
    }
  });
  
  pane.activeTerminalId = terminalId;
  
  // Update global active if this is the active pane
  if (paneId === terminalState.activePaneId) {
    terminalState.activeTerminalId = terminalId;
    const entry = terminalState.terminals.get(terminalId);
    if (entry) {
      state.terminal = entry.terminal;
      state.terminalFitAddon = entry.fitAddon;
      state.terminalSearchAddon = entry.searchAddon;
      setTimeout(() => entry.fitAddon.fit(), 10);
    }
  }
  
  renderTerminalTabsForPane(paneId);
}

function focusPane(paneId) {
  terminalState.activePaneId = paneId;
  const pane = terminalState.panes.get(paneId);
  if (pane?.activeTerminalId) {
    terminalState.activeTerminalId = pane.activeTerminalId;
    const entry = terminalState.terminals.get(pane.activeTerminalId);
    if (entry) {
      state.terminal = entry.terminal;
      state.terminalFitAddon = entry.fitAddon;
      state.terminalSearchAddon = entry.searchAddon;
      entry.terminal.focus();
    }
  }
  
  // Update pane visual focus
  document.querySelectorAll('.terminal-pane').forEach(el => {
    el.classList.toggle('focused', el.dataset.paneId === paneId);
  });
}

function renderSplitTerminals() {
  const mainContainer = document.getElementById('terminal');
  if (!mainContainer) return;
  
  const paneIds = Array.from(terminalState.panes.keys());
  
  if (terminalState.splitMode === 'none' || paneIds.length <= 1) {
    // Single pane mode
    mainContainer.className = 'terminal-container';
    mainContainer.innerHTML = `
      <div id="terminalTabs" class="terminal-tabs"></div>
      <div id="terminalInstances" class="terminal-instances"></div>
    `;
    
    // Move all terminal containers back
    const instances = document.getElementById('terminalInstances');
    terminalState.terminals.forEach(entry => {
      instances.appendChild(entry.container);
    });
    
    renderTerminalTabs();
  } else {
    // Split mode
    const splitClass = terminalState.splitMode === 'horizontal' 
      ? 'terminal-split-horizontal' 
      : 'terminal-split-vertical';
    
    mainContainer.className = `terminal-container ${splitClass}`;
    
    let html = '';
    paneIds.forEach((paneId, index) => {
      html += `
        <div class="terminal-pane ${paneId === terminalState.activePaneId ? 'focused' : ''}" 
             data-pane-id="${paneId}"
             onclick="focusPane('${paneId}')">
          <div id="terminalTabs-${paneId}" class="terminal-tabs"></div>
          <div id="terminalInstances-${paneId}" class="terminal-instances"></div>
        </div>
        ${index < paneIds.length - 1 ? '<div class="terminal-split-handle"></div>' : ''}
      `;
    });
    
    mainContainer.innerHTML = html;
    
    // Move terminals to their panes
    paneIds.forEach(paneId => {
      const instances = document.getElementById(`terminalInstances-${paneId}`);
      const pane = terminalState.panes.get(paneId);
      pane.terminalIds.forEach(id => {
        const entry = terminalState.terminals.get(id);
        if (entry && instances) {
          instances.appendChild(entry.container);
        }
      });
      renderTerminalTabsForPane(paneId);
    });
    
    // Setup resize handles
    setupSplitResizeHandles();
  }
  
  // Refit all terminals
  setTimeout(() => {
    terminalState.terminals.forEach(entry => entry.fitAddon.fit());
  }, 50);
}

function renderTerminalTabsForPane(paneId) {
  const tabBar = document.getElementById(`terminalTabs-${paneId}`);
  if (!tabBar) return;
  
  const pane = terminalState.panes.get(paneId);
  if (!pane) return;
  
  let html = '';
  pane.terminalIds.forEach(id => {
    const entry = terminalState.terminals.get(id);
    if (!entry) return;
    
    const isActive = id === pane.activeTerminalId;
    const profile = terminalProfiles.find(p => p.id === entry.profile) || {};
    html += `
      <div class="terminal-tab ${isActive ? 'active' : ''}" 
           onclick="switchToTerminalInPane(${id}, '${paneId}')"
           ondblclick="renameTerminal(${id})">
        <span class="terminal-tab-icon">${profile.icon || '⬛'}</span>
        <span class="terminal-tab-name">${entry.name}</span>
        ${pane.terminalIds.length > 1 ? `
          <button class="terminal-tab-close" onclick="event.stopPropagation(); closeTerminalInPane(${id}, '${paneId}')">×</button>
        ` : ''}
      </div>
    `;
  });
  
  html += `
    <button class="terminal-tab-add" onclick="createTerminalInPane('zsh', null, '${paneId}')" title="New Terminal">+</button>
  `;
  
  tabBar.innerHTML = html;
}

function closeTerminalInPane(terminalId, paneId) {
  const entry = terminalState.terminals.get(terminalId);
  if (!entry) return;
  
  const pane = terminalState.panes.get(paneId);
  if (!pane) return;
  
  // Kill PTY
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'terminal:kill', id: terminalId }));
  }
  
  entry.terminal.dispose();
  entry.container.remove();
  terminalState.terminals.delete(terminalId);
  
  // Remove from pane
  pane.terminalIds = pane.terminalIds.filter(id => id !== terminalId);
  
  // If pane is empty, close it (unless it's the only pane)
  if (pane.terminalIds.length === 0 && terminalState.panes.size > 1) {
    terminalState.panes.delete(paneId);
    if (terminalState.activePaneId === paneId) {
      terminalState.activePaneId = terminalState.panes.keys().next().value;
    }
    renderSplitTerminals();
  } else if (pane.terminalIds.length === 0) {
    // Last terminal in last pane - create new one
    createTerminalInPane('zsh', null, paneId);
  } else {
    // Switch to another terminal in this pane
    pane.activeTerminalId = pane.terminalIds[0];
    switchToTerminalInPane(pane.activeTerminalId, paneId);
  }
}

function setupSplitResizeHandles() {
  const handles = document.querySelectorAll('.terminal-split-handle');
  
  handles.forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const container = handle.parentElement;
      const panes = container.querySelectorAll('.terminal-pane');
      if (panes.length < 2) return;
      
      const isHorizontal = terminalState.splitMode === 'horizontal';
      const startPos = isHorizontal ? e.clientY : e.clientX;
      const startSizes = Array.from(panes).map(p => 
        isHorizontal ? p.offsetHeight : p.offsetWidth
      );
      
      const onMove = (moveE) => {
        const delta = (isHorizontal ? moveE.clientY : moveE.clientX) - startPos;
        const newSize1 = Math.max(100, startSizes[0] + delta);
        const newSize2 = Math.max(100, startSizes[1] - delta);
        
        if (isHorizontal) {
          panes[0].style.height = `${newSize1}px`;
          panes[1].style.height = `${newSize2}px`;
        } else {
          panes[0].style.width = `${newSize1}px`;
          panes[1].style.width = `${newSize2}px`;
        }
        
        // Refit terminals
        terminalState.terminals.forEach(entry => entry.fitAddon.fit());
      };
      
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// Export to window
window.terminalState = terminalState;
window.terminalProfiles = terminalProfiles;
window.quickCommands = quickCommands;
window.createTerminal = createTerminal;
window.createTerminalWithProfile = createTerminalWithProfile;
window.switchToTerminal = switchToTerminal;
window.closeTerminal = closeTerminal;
window.renameTerminal = renameTerminal;
window.initTerminal = initTerminal;
window.startTerminal = startTerminal;
window.toggleTerminal = toggleTerminal;
window.clearTerminal = clearTerminal;
window.handleTerminalOutput = handleTerminalOutput;
window.toggleProfileMenu = toggleProfileMenu;
window.showQuickCommands = showQuickCommands;
window.closeQuickCommands = closeQuickCommands;
window.runQuickCommand = runQuickCommand;
window.runCustomCommand = runCustomCommand;
// Split terminal exports
window.splitTerminal = splitTerminal;
window.unsplitTerminal = unsplitTerminal;
window.focusPane = focusPane;
window.createTerminalInPane = createTerminalInPane;
window.switchToTerminalInPane = switchToTerminalInPane;
window.closeTerminalInPane = closeTerminalInPane;
