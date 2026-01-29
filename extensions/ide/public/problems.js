// ============================================
// PROBLEMS PANEL (Sprint 3)
// ============================================

const problemsState = {
  problems: [], // { file, line, column, severity: 'error'|'warning'|'info', message, source, code }
  filter: 'all', // 'all'|'error'|'warning'|'info'
  searchQuery: ''
};

// Initialize problems panel
function initProblemsPanel() {
  // Setup search input
  const searchInput = document.getElementById('problemsSearch');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      problemsState.searchQuery = e.target.value;
      renderProblems();
    });
  }
  
  // Initial fetch
  refreshProblems();
  
  // Auto-refresh every 30 seconds when panel is visible
  setInterval(() => {
    const panel = document.getElementById('bottomPanelProblems');
    if (panel && !panel.classList.contains('hidden')) {
      refreshProblems();
    }
  }, 30000);
}

// Fetch problems from server
async function refreshProblems() {
  try {
    const res = await fetch('/api/problems');
    const data = await res.json();
    
    if (data.problems) {
      problemsState.problems = data.problems;
      renderProblems();
      updateProblemsCounts();
    }
  } catch (err) {
    console.error('Failed to fetch problems:', err);
  }
}

// Render problems list
function renderProblems() {
  const container = document.getElementById('problemsList');
  if (!container) return;
  
  // Filter problems
  let filtered = problemsState.problems;
  
  if (problemsState.filter !== 'all') {
    filtered = filtered.filter(p => p.severity === problemsState.filter);
  }
  
  if (problemsState.searchQuery) {
    const query = problemsState.searchQuery.toLowerCase();
    filtered = filtered.filter(p => 
      p.message.toLowerCase().includes(query) ||
      p.file.toLowerCase().includes(query) ||
      (p.code && p.code.toLowerCase().includes(query))
    );
  }
  
  if (filtered.length === 0) {
    container.innerHTML = '<div class="problems-empty">No problems detected</div>';
    return;
  }
  
  // Group by file
  const grouped = {};
  for (const problem of filtered) {
    if (!grouped[problem.file]) {
      grouped[problem.file] = [];
    }
    grouped[problem.file].push(problem);
  }
  
  container.innerHTML = Object.entries(grouped).map(([file, problems]) => {
    const fileName = file.split('/').pop();
    const errorCount = problems.filter(p => p.severity === 'error').length;
    const warningCount = problems.filter(p => p.severity === 'warning').length;
    
    return `
      <div class="problems-file-group">
        <div class="problems-file-header" onclick="toggleProblemsFile(this)">
          <span class="problems-file-icon">▼</span>
          <span class="problems-file-name" title="${escapeHtml(file)}">${escapeHtml(fileName)}</span>
          <span class="problems-file-counts">
            ${errorCount > 0 ? `<span class="error">${errorCount}</span>` : ''}
            ${warningCount > 0 ? `<span class="warning">${warningCount}</span>` : ''}
          </span>
        </div>
        <div class="problems-file-items">
          ${problems.map(p => renderProblemItem(p)).join('')}
        </div>
      </div>
    `;
  }).join('');
}

function renderProblemItem(problem) {
  const severityIcon = {
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  }[problem.severity] || '○';
  
  return `
    <div class="problems-item ${problem.severity}" onclick="goToProblem('${escapeHtml(problem.file)}', ${problem.line}, ${problem.column})">
      <span class="problems-item-icon ${problem.severity}">${severityIcon}</span>
      <span class="problems-item-message">${escapeHtml(problem.message)}</span>
      <span class="problems-item-location">Ln ${problem.line}, Col ${problem.column}</span>
      ${problem.code ? `<span class="problems-item-code">[${escapeHtml(problem.code)}]</span>` : ''}
      ${problem.source ? `<span class="problems-item-source">${escapeHtml(problem.source)}</span>` : ''}
    </div>
  `;
}

function toggleProblemsFile(header) {
  const items = header.nextElementSibling;
  const icon = header.querySelector('.problems-file-icon');
  
  if (items.classList.contains('collapsed')) {
    items.classList.remove('collapsed');
    icon.textContent = '▼';
  } else {
    items.classList.add('collapsed');
    icon.textContent = '▶';
  }
}

function filterProblems(filter) {
  problemsState.filter = filter;
  
  // Update UI
  document.querySelectorAll('.problems-filter').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  
  renderProblems();
}

function goToProblem(file, line, column) {
  // Open file and go to line
  openFile(file, false).then(() => {
    const pane = getActivePane();
    if (pane && pane.editor) {
      pane.editor.revealLineInCenter(line);
      pane.editor.setPosition({ lineNumber: line, column: column });
      pane.editor.focus();
    }
  });
}

function updateProblemsCounts() {
  const problems = problemsState.problems;
  const errors = problems.filter(p => p.severity === 'error').length;
  const warnings = problems.filter(p => p.severity === 'warning').length;
  const infos = problems.filter(p => p.severity === 'info').length;
  
  // Update filter buttons
  const errorEl = document.getElementById('problemsErrorCount');
  const warningEl = document.getElementById('problemsWarningCount');
  const infoEl = document.getElementById('problemsInfoCount');
  
  if (errorEl) errorEl.textContent = errors;
  if (warningEl) warningEl.textContent = warnings;
  if (infoEl) infoEl.textContent = infos;
  
  // Update badge
  const badge = document.getElementById('problemsBadge');
  const total = errors + warnings;
  if (badge) {
    badge.textContent = total;
    badge.classList.toggle('hidden', total === 0);
    badge.classList.toggle('has-errors', errors > 0);
  }
  
  // Update status bar
  const statusErrors = document.getElementById('statusErrorCount');
  const statusWarnings = document.getElementById('statusWarningCount');
  if (statusErrors) statusErrors.textContent = errors;
  if (statusWarnings) statusWarnings.textContent = warnings;
}

// ============================================
// BOTTOM PANEL MANAGEMENT
// ============================================

function switchBottomPanel(panel) {
  // Update tabs
  document.querySelectorAll('.bottom-panel-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.panel === panel);
  });
  
  // Update content
  const terminalPanel = document.getElementById('bottomPanelTerminal');
  const problemsPanel = document.getElementById('bottomPanelProblems');
  
  if (panel === 'terminal') {
    terminalPanel.classList.remove('hidden');
    problemsPanel.classList.add('hidden');
    // Fit terminal
    if (state.terminalFitAddon) {
      setTimeout(() => state.terminalFitAddon.fit(), 100);
    }
  } else {
    terminalPanel.classList.add('hidden');
    problemsPanel.classList.remove('hidden');
    // Refresh problems when switching to panel
    refreshProblems();
  }
}

function toggleBottomPanel() {
  const container = document.getElementById('bottomPanelContainer');
  container.classList.toggle('collapsed');
  
  // Refit terminal after resize
  if (state.terminalFitAddon) {
    setTimeout(() => state.terminalFitAddon.fit(), 100);
  }
}

function toggleProblemsPanel() {
  // Ensure bottom panel is visible
  const container = document.getElementById('bottomPanelContainer');
  if (container.classList.contains('collapsed')) {
    container.classList.remove('collapsed');
  }
  
  // Switch to problems tab
  switchBottomPanel('problems');
}

// ============================================
// GIT DIFF VIEWER (Sprint 3)
// ============================================

async function showGitDiffViewer(file) {
  try {
    const res = await fetch(`/api/git/diff?file=${encodeURIComponent(file || '')}`);
    const data = await res.json();
    
    if (!data.diff || data.diff.trim() === '') {
      showNotification('No changes to display', 'info');
      return;
    }
    
    // Create diff viewer modal
    openDiffModal(file || 'All Changes', data.diff);
  } catch (err) {
    showNotification('Failed to load diff: ' + err.message, 'error');
  }
}

function openDiffModal(title, diffContent) {
  // Remove existing modal
  const existing = document.getElementById('diffViewerModal');
  if (existing) existing.remove();
  
  const modal = document.createElement('div');
  modal.id = 'diffViewerModal';
  modal.className = 'diff-viewer-modal';
  
  const parsedDiff = parseDiff(diffContent);
  
  modal.innerHTML = `
    <div class="diff-viewer-header">
      <div class="diff-viewer-title">
        <span class="diff-icon">📝</span>
        <span>${escapeHtml(title)}</span>
      </div>
      <div class="diff-viewer-actions">
        <button onclick="toggleDiffViewMode()" id="diffViewModeBtn" title="Toggle view mode">Side by Side</button>
        <button onclick="closeDiffModal()" title="Close">×</button>
      </div>
    </div>
    <div class="diff-viewer-content" id="diffViewerContent">
      ${renderInlineDiff(parsedDiff)}
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Show overlay
  const overlay = document.getElementById('overlay');
  overlay.classList.remove('hidden');
  overlay.onclick = closeDiffModal;
  
  // Store parsed diff for view mode toggle
  modal.dataset.diff = JSON.stringify(parsedDiff);
  modal.dataset.mode = 'inline';
}

function closeDiffModal() {
  const modal = document.getElementById('diffViewerModal');
  if (modal) modal.remove();
  
  const overlay = document.getElementById('overlay');
  overlay.classList.add('hidden');
  overlay.onclick = closeAllModals;
}

function toggleDiffViewMode() {
  const modal = document.getElementById('diffViewerModal');
  const content = document.getElementById('diffViewerContent');
  const btn = document.getElementById('diffViewModeBtn');
  
  const parsedDiff = JSON.parse(modal.dataset.diff);
  const currentMode = modal.dataset.mode;
  
  if (currentMode === 'inline') {
    modal.dataset.mode = 'split';
    btn.textContent = 'Inline';
    content.innerHTML = renderSplitDiff(parsedDiff);
  } else {
    modal.dataset.mode = 'inline';
    btn.textContent = 'Side by Side';
    content.innerHTML = renderInlineDiff(parsedDiff);
  }
}

function parseDiff(diffText) {
  const files = [];
  let currentFile = null;
  let currentHunk = null;
  
  const lines = diffText.split('\n');
  
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentFile) files.push(currentFile);
      currentFile = { name: '', hunks: [] };
    } else if (line.startsWith('--- ')) {
      // Old file name
    } else if (line.startsWith('+++ ')) {
      if (currentFile) {
        currentFile.name = line.substring(6); // Remove '+++ b/'
      }
    } else if (line.startsWith('@@')) {
      if (currentFile) {
        currentHunk = { header: line, lines: [] };
        currentFile.hunks.push(currentHunk);
      }
    } else if (currentHunk) {
      const type = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'context';
      currentHunk.lines.push({ type, content: line.substring(1) || '' });
    }
  }
  
  if (currentFile) files.push(currentFile);
  return files;
}

function renderInlineDiff(files) {
  return files.map(file => `
    <div class="diff-file">
      <div class="diff-file-header">${escapeHtml(file.name)}</div>
      ${file.hunks.map(hunk => `
        <div class="diff-hunk">
          <div class="diff-hunk-header">${escapeHtml(hunk.header)}</div>
          ${hunk.lines.map(line => `
            <div class="diff-line ${line.type}">
              <span class="diff-line-prefix">${line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}</span>
              <span class="diff-line-content">${escapeHtml(line.content)}</span>
            </div>
          `).join('')}
        </div>
      `).join('')}
    </div>
  `).join('');
}

function renderSplitDiff(files) {
  return files.map(file => {
    const leftLines = [];
    const rightLines = [];
    
    for (const hunk of file.hunks) {
      leftLines.push({ type: 'header', content: hunk.header });
      rightLines.push({ type: 'header', content: hunk.header });
      
      let i = 0;
      while (i < hunk.lines.length) {
        const line = hunk.lines[i];
        
        if (line.type === 'context') {
          leftLines.push(line);
          rightLines.push(line);
          i++;
        } else if (line.type === 'removed') {
          // Check if next line is added (paired change)
          if (i + 1 < hunk.lines.length && hunk.lines[i + 1].type === 'added') {
            leftLines.push(line);
            rightLines.push(hunk.lines[i + 1]);
            i += 2;
          } else {
            leftLines.push(line);
            rightLines.push({ type: 'empty', content: '' });
            i++;
          }
        } else if (line.type === 'added') {
          leftLines.push({ type: 'empty', content: '' });
          rightLines.push(line);
          i++;
        } else {
          i++;
        }
      }
    }
    
    return `
      <div class="diff-file">
        <div class="diff-file-header">${escapeHtml(file.name)}</div>
        <div class="diff-split">
          <div class="diff-split-side left">
            ${leftLines.map(line => `
              <div class="diff-line ${line.type}">
                <span class="diff-line-content">${escapeHtml(line.content)}</span>
              </div>
            `).join('')}
          </div>
          <div class="diff-split-side right">
            ${rightLines.map(line => `
              <div class="diff-line ${line.type}">
                <span class="diff-line-content">${escapeHtml(line.content)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================
// TERMINAL SEARCH (Sprint 3)
// ============================================

const terminalSearchState = {
  visible: false,
  query: '',
  matches: [],
  currentMatch: 0
};

function toggleTerminalSearch() {
  terminalSearchState.visible = !terminalSearchState.visible;
  
  let searchBar = document.getElementById('terminalSearchBar');
  
  if (!searchBar && terminalSearchState.visible) {
    // Create search bar
    searchBar = document.createElement('div');
    searchBar.id = 'terminalSearchBar';
    searchBar.className = 'terminal-search-bar';
    searchBar.innerHTML = `
      <input type="text" id="terminalSearchInput" placeholder="Search terminal..." 
             onkeydown="handleTerminalSearchKey(event)" oninput="searchTerminal(this.value)">
      <span id="terminalSearchCount">0/0</span>
      <button onclick="terminalSearchPrev()">↑</button>
      <button onclick="terminalSearchNext()">↓</button>
      <button onclick="toggleTerminalSearch()">×</button>
    `;
    
    const terminalPanel = document.getElementById('bottomPanelTerminal');
    terminalPanel.insertBefore(searchBar, terminalPanel.firstChild);
    
    // Focus input
    document.getElementById('terminalSearchInput').focus();
  } else if (searchBar) {
    if (terminalSearchState.visible) {
      searchBar.classList.remove('hidden');
      document.getElementById('terminalSearchInput').focus();
    } else {
      searchBar.classList.add('hidden');
      // Clear search
      clearTerminalSearch();
    }
  }
}

function searchTerminal(query) {
  terminalSearchState.query = query;
  
  if (state.terminalSearchAddon && query) {
    // Use xterm-addon-search
    const found = state.terminalSearchAddon.findNext(query, { 
      regex: false,
      wholeWord: false,
      caseSensitive: false,
      decorations: {
        matchBackground: '#FFD70044',
        matchOverviewRuler: '#FFD700',
        activeMatchBackground: '#FFD700',
        activeMatchColorOverviewRuler: '#FFD700'
      }
    });
    
    // Update count display (xterm-addon-search doesn't provide count easily)
    document.getElementById('terminalSearchCount').textContent = found ? '✓' : '0/0';
  } else if (!query && state.terminalSearchAddon) {
    state.terminalSearchAddon.clearDecorations();
    document.getElementById('terminalSearchCount').textContent = '0/0';
  }
}

function handleTerminalSearchKey(event) {
  if (event.key === 'Enter') {
    if (event.shiftKey) {
      terminalSearchPrev();
    } else {
      terminalSearchNext();
    }
  } else if (event.key === 'Escape') {
    toggleTerminalSearch();
  }
}

function terminalSearchNext() {
  if (state.terminalSearchAddon && terminalSearchState.query) {
    state.terminalSearchAddon.findNext(terminalSearchState.query);
  }
}

function terminalSearchPrev() {
  if (state.terminalSearchAddon && terminalSearchState.query) {
    state.terminalSearchAddon.findPrevious(terminalSearchState.query);
  }
}

function clearTerminalSearch() {
  terminalSearchState.query = '';
  terminalSearchState.matches = [];
  terminalSearchState.currentMatch = 0;
  if (state.terminalSearchAddon) {
    state.terminalSearchAddon.clearDecorations();
  }
}

// Export functions
window.initProblemsPanel = initProblemsPanel;
window.refreshProblems = refreshProblems;
window.filterProblems = filterProblems;
window.goToProblem = goToProblem;
window.toggleProblemsFile = toggleProblemsFile;
window.switchBottomPanel = switchBottomPanel;
window.toggleBottomPanel = toggleBottomPanel;
window.toggleProblemsPanel = toggleProblemsPanel;
window.showGitDiffViewer = showGitDiffViewer;
window.closeDiffModal = closeDiffModal;
window.toggleDiffViewMode = toggleDiffViewMode;
window.toggleTerminalSearch = toggleTerminalSearch;
window.searchTerminal = searchTerminal;
window.handleTerminalSearchKey = handleTerminalSearchKey;
window.terminalSearchNext = terminalSearchNext;
window.terminalSearchPrev = terminalSearchPrev;
