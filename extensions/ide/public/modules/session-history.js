// ============================================
// SESSION HISTORY MODULE - Past Conversations About Current File
// ============================================
// Unique feature: Show what was discussed/decided about the current file
// Leverages DNA memory files that no competitor has

const sessionHistoryState = {
  isOpen: false,
  currentFile: null,
  results: [],
  cache: new Map(), // filePath -> { results, timestamp }
  cacheExpiry: 60000, // 1 minute cache
};

/**
 * Initialize session history module
 */
function initSessionHistory() {
  // Register keyboard shortcut
  document.addEventListener('keydown', (e) => {
    // Cmd+Shift+H to show history for current file
    if (e.metaKey && e.shiftKey && e.key === 'h') {
      e.preventDefault();
      toggleSessionHistory();
    }
  });
  
  console.log('📜 Session history initialized');
}

/**
 * Toggle session history panel
 */
function toggleSessionHistory() {
  if (sessionHistoryState.isOpen) {
    closeSessionHistory();
  } else {
    openSessionHistory();
  }
}

/**
 * Open session history for current file
 */
async function openSessionHistory() {
  const filePath = state.currentFile;
  if (!filePath) {
    showNotification('No file open', 'warning');
    return;
  }
  
  let panel = document.getElementById('sessionHistoryPanel');
  if (!panel) {
    panel = createSessionHistoryPanel();
    document.body.appendChild(panel);
  }
  
  panel.classList.remove('hidden');
  sessionHistoryState.isOpen = true;
  sessionHistoryState.currentFile = filePath;
  
  // Show loading
  document.getElementById('sessionHistoryResults').innerHTML = `
    <div class="session-history-loading">
      <div class="loading-spinner"></div>
      <span>Searching memory...</span>
    </div>
  `;
  
  // Search for references to this file
  await searchFileHistory(filePath);
}

/**
 * Close session history panel
 */
function closeSessionHistory() {
  const panel = document.getElementById('sessionHistoryPanel');
  if (panel) {
    panel.classList.add('hidden');
  }
  sessionHistoryState.isOpen = false;
}

/**
 * Create session history panel HTML
 */
function createSessionHistoryPanel() {
  const panel = document.createElement('div');
  panel.id = 'sessionHistoryPanel';
  panel.className = 'session-history-panel hidden';
  
  panel.innerHTML = `
    <div class="session-history-overlay" onclick="closeSessionHistory()"></div>
    <div class="session-history-modal">
      <div class="session-history-header">
        <span class="session-history-icon">📜</span>
        <span class="session-history-title">File History</span>
        <span class="session-history-file" id="sessionHistoryFile"></span>
        <button class="session-history-close" onclick="closeSessionHistory()">×</button>
      </div>
      <div class="session-history-tabs">
        <button class="history-tab active" data-tab="conversations" onclick="switchHistoryTab('conversations')">
          💬 Conversations
        </button>
        <button class="history-tab" data-tab="decisions" onclick="switchHistoryTab('decisions')">
          ✓ Decisions
        </button>
        <button class="history-tab" data-tab="changes" onclick="switchHistoryTab('changes')">
          📝 Changes
        </button>
      </div>
      <div class="session-history-results" id="sessionHistoryResults">
        <!-- Results rendered here -->
      </div>
      <div class="session-history-footer">
        <span class="session-history-tip">
          Tip: Add notes with <kbd>Cmd+Shift+N</kbd> to build file history
        </span>
      </div>
    </div>
  `;
  
  return panel;
}

/**
 * Search memory files for references to a file
 * @param {string} filePath - Path to search for
 */
async function searchFileHistory(filePath) {
  // Check cache
  const cached = sessionHistoryState.cache.get(filePath);
  if (cached && Date.now() - cached.timestamp < sessionHistoryState.cacheExpiry) {
    renderHistoryResults(cached.results, 'conversations');
    return;
  }
  
  const fileName = filePath.split('/').pop();
  const fileNameNoExt = fileName.replace(/\.[^.]+$/, '');
  
  // Update header
  document.getElementById('sessionHistoryFile').textContent = fileName;
  
  try {
    // Search for file references in memory
    const response = await fetch('/api/session-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        filePath,
        fileName,
        fileNameNoExt,
        limit: 50 
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      renderHistoryError(data.error);
      return;
    }
    
    sessionHistoryState.results = data.results || [];
    
    // Cache results
    sessionHistoryState.cache.set(filePath, {
      results: sessionHistoryState.results,
      timestamp: Date.now()
    });
    
    renderHistoryResults(sessionHistoryState.results, 'conversations');
    
  } catch (err) {
    console.error('Session history error:', err);
    renderHistoryError(err.message);
  }
}

/**
 * Render history results
 * @param {Array} results - Search results
 * @param {string} tab - Current tab
 */
function renderHistoryResults(results, tab) {
  const container = document.getElementById('sessionHistoryResults');
  if (!container) return;
  
  // Filter by tab
  let filtered = results;
  if (tab === 'decisions') {
    filtered = results.filter(r => 
      r.content.toLowerCase().includes('decided') ||
      r.content.toLowerCase().includes('decision') ||
      r.content.toLowerCase().includes('will use') ||
      r.content.toLowerCase().includes('agreed') ||
      r.content.includes('✓') ||
      r.content.includes('[x]')
    );
  } else if (tab === 'changes') {
    filtered = results.filter(r =>
      r.content.toLowerCase().includes('changed') ||
      r.content.toLowerCase().includes('modified') ||
      r.content.toLowerCase().includes('added') ||
      r.content.toLowerCase().includes('removed') ||
      r.content.toLowerCase().includes('updated') ||
      r.content.toLowerCase().includes('refactored')
    );
  }
  
  if (!filtered || filtered.length === 0) {
    container.innerHTML = `
      <div class="session-history-empty">
        <span class="empty-icon">📭</span>
        <span class="empty-text">No ${tab} found for this file</span>
        <span class="empty-hint">Conversations about this file will appear here</span>
      </div>
    `;
    return;
  }
  
  // Group by date
  const byDate = {};
  for (const result of filtered) {
    const date = result.date || 'Unknown';
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(result);
  }
  
  let html = '';
  
  for (const [date, items] of Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0]))) {
    const dateLabel = formatHistoryDate(date);
    
    html += `
      <div class="history-date-group">
        <div class="history-date-header">${dateLabel}</div>
    `;
    
    for (const item of items) {
      const icon = getHistoryIcon(item.type);
      const snippet = highlightFileRef(item.content, sessionHistoryState.currentFile);
      
      html += `
        <div class="history-item" onclick="openHistorySource('${escapeHtml(item.file)}', ${item.line})">
          <div class="history-item-header">
            <span class="history-item-icon">${icon}</span>
            <span class="history-item-time">${item.time || ''}</span>
            <span class="history-item-source">${escapeHtml(item.file?.split('/').pop() || '')}</span>
          </div>
          <div class="history-item-content">${snippet}</div>
        </div>
      `;
    }
    
    html += '</div>';
  }
  
  container.innerHTML = html;
}

/**
 * Render error state
 */
function renderHistoryError(message) {
  const container = document.getElementById('sessionHistoryResults');
  if (!container) return;
  
  container.innerHTML = `
    <div class="session-history-empty error">
      <span class="empty-icon">⚠</span>
      <span class="empty-text">Error loading history</span>
      <span class="empty-hint">${escapeHtml(message)}</span>
    </div>
  `;
}

/**
 * Switch history tab
 * @param {string} tab - Tab name
 */
function switchHistoryTab(tab) {
  // Update tab buttons
  document.querySelectorAll('.history-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  
  // Re-render with filter
  renderHistoryResults(sessionHistoryState.results, tab);
}

/**
 * Open the source file where history was found
 * @param {string} file - File path
 * @param {number} line - Line number
 */
function openHistorySource(file, line) {
  closeSessionHistory();
  
  if (typeof openFile === 'function') {
    openFile(file).then(() => {
      if (state.editor && line) {
        state.editor.revealLineInCenter(line);
        state.editor.setPosition({ lineNumber: line, column: 1 });
      }
    });
  }
}

/**
 * Format date for display
 */
function formatHistoryDate(dateStr) {
  if (!dateStr || dateStr === 'Unknown') return 'Unknown Date';
  
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  if (dateStr === today.toISOString().split('T')[0]) {
    return 'Today';
  } else if (dateStr === yesterday.toISOString().split('T')[0]) {
    return 'Yesterday';
  }
  
  return date.toLocaleDateString('en-US', { 
    weekday: 'long', 
    month: 'short', 
    day: 'numeric' 
  });
}

/**
 * Get icon for history item type
 */
function getHistoryIcon(type) {
  const icons = {
    conversation: '💬',
    decision: '✓',
    change: '📝',
    note: '📌',
    todo: '☐',
    bug: '🐛',
  };
  return icons[type] || '📄';
}

/**
 * Highlight file reference in content
 */
function highlightFileRef(content, filePath) {
  if (!content || !filePath) return escapeHtml(content || '');
  
  const fileName = filePath.split('/').pop();
  const escaped = escapeHtml(content);
  
  // Highlight file references
  const regex = new RegExp(`(${escapeRegex(fileName)}|${escapeRegex(filePath)})`, 'gi');
  return escaped.replace(regex, '<mark>$1</mark>');
}

/**
 * Escape regex special characters
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape HTML
 */
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Add a note about the current file
 */
async function addFileNote() {
  const filePath = state.currentFile;
  if (!filePath) {
    showNotification('No file open', 'warning');
    return;
  }
  
  const note = prompt(`Add a note about ${filePath.split('/').pop()}:`);
  if (!note) return;
  
  try {
    await fetch('/api/memory/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        note: `[${filePath}] ${note}`,
        category: 'file-note'
      })
    });
    
    showNotification('📌 Note added', 'success');
    
    // Invalidate cache
    sessionHistoryState.cache.delete(filePath);
    
  } catch (err) {
    showNotification('Failed to add note', 'error');
  }
}

// Export functions
window.initSessionHistory = initSessionHistory;
window.toggleSessionHistory = toggleSessionHistory;
window.openSessionHistory = openSessionHistory;
window.closeSessionHistory = closeSessionHistory;
window.switchHistoryTab = switchHistoryTab;
window.openHistorySource = openHistorySource;
window.addFileNote = addFileNote;

// Initialize on load
document.addEventListener('DOMContentLoaded', initSessionHistory);
