// ============================================
// AI ATTRIBUTION MODULE - Track AI vs Human Code
// ============================================
// Tracks which lines were AI-generated, shows gutter indicators,
// and links to the conversation that produced the code

const attributionState = {
  // filePath -> { ranges: [...], lastUpdated }
  files: new Map(),
  enabled: true,
  showGutter: true,
  currentSession: null,
  pendingChanges: [],
  decorations: [], // Monaco decoration IDs
};

/**
 * Initialize AI attribution module
 */
function initAttribution() {
  // Load settings
  const saved = localStorage.getItem('attributionEnabled');
  if (saved !== null) {
    attributionState.enabled = saved === 'true';
  }
  
  const showGutter = localStorage.getItem('attributionShowGutter');
  if (showGutter !== null) {
    attributionState.showGutter = showGutter === 'true';
  }
  
  // Generate session ID for this session
  attributionState.currentSession = generateSessionId();
  
  // Load attribution data for workspace
  loadWorkspaceAttribution();
  
  console.log('📊 AI Attribution initialized, session:', attributionState.currentSession);
}

/**
 * Generate a unique session ID
 */
function generateSessionId() {
  const date = new Date().toISOString().split('T')[0];
  const rand = Math.random().toString(36).substring(2, 8);
  return `${date}-${rand}`;
}

/**
 * Load attribution data from server
 */
async function loadWorkspaceAttribution() {
  try {
    const response = await fetch('/api/attribution');
    const data = await response.json();
    
    if (data.files) {
      for (const [filePath, fileData] of Object.entries(data.files)) {
        attributionState.files.set(filePath, fileData);
      }
    }
    
    console.log(`📊 Loaded attribution for ${attributionState.files.size} files`);
  } catch (err) {
    console.error('Failed to load attribution:', err);
  }
}

/**
 * Save attribution data to server
 */
async function saveAttribution() {
  try {
    const files = {};
    attributionState.files.forEach((data, path) => {
      files[path] = data;
    });
    
    await fetch('/api/attribution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files })
    });
  } catch (err) {
    console.error('Failed to save attribution:', err);
  }
}

/**
 * Record AI-generated code for a file
 * @param {string} filePath - Path to the file
 * @param {number} startLine - Start line (1-indexed)
 * @param {number} endLine - End line (1-indexed)
 * @param {Object} metadata - Additional metadata
 */
function recordAICode(filePath, startLine, endLine, metadata = {}) {
  if (!attributionState.enabled) return;
  
  const relativePath = filePath.replace(/^\//, '');
  
  let fileData = attributionState.files.get(relativePath);
  if (!fileData) {
    fileData = { ranges: [], lastUpdated: Date.now() };
    attributionState.files.set(relativePath, fileData);
  }
  
  const newRange = {
    start: startLine,
    end: endLine,
    type: 'ai',
    date: new Date().toISOString(),
    session: attributionState.currentSession,
    model: metadata.model || 'clawd',
    task: metadata.task || null,
    ...metadata
  };
  
  // Merge overlapping ranges
  fileData.ranges = mergeRanges([...fileData.ranges, newRange]);
  fileData.lastUpdated = Date.now();
  
  // Queue save
  debouncedSaveAttribution();
  
  // Update gutter if file is open
  if (state.currentFile === relativePath) {
    updateAttributionGutter();
  }
  
  console.log(`📊 Recorded AI code: ${relativePath} lines ${startLine}-${endLine}`);
}

/**
 * Record human edit (removes AI attribution for affected lines)
 * @param {string} filePath - Path to the file
 * @param {number} startLine - Start line of edit
 * @param {number} endLine - End line of edit
 */
function recordHumanEdit(filePath, startLine, endLine) {
  if (!attributionState.enabled) return;
  
  const relativePath = filePath.replace(/^\//, '');
  const fileData = attributionState.files.get(relativePath);
  if (!fileData) return;
  
  // Remove or split ranges that overlap with the human edit
  fileData.ranges = fileData.ranges.flatMap(range => {
    // No overlap
    if (range.end < startLine || range.start > endLine) {
      return [range];
    }
    
    // Completely covered by human edit - remove
    if (range.start >= startLine && range.end <= endLine) {
      return [];
    }
    
    // Partial overlap - split
    const result = [];
    
    // Part before the edit
    if (range.start < startLine) {
      result.push({ ...range, end: startLine - 1 });
    }
    
    // Part after the edit
    if (range.end > endLine) {
      result.push({ ...range, start: endLine + 1 });
    }
    
    return result;
  });
  
  fileData.lastUpdated = Date.now();
  debouncedSaveAttribution();
  
  // Update gutter
  if (state.currentFile === relativePath) {
    updateAttributionGutter();
  }
}

/**
 * Merge overlapping ranges
 */
function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  
  // Sort by start line
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    
    // Check if overlapping or adjacent
    if (current.start <= last.end + 1) {
      // Merge - keep the more recent metadata
      last.end = Math.max(last.end, current.end);
      if (new Date(current.date) > new Date(last.date)) {
        last.date = current.date;
        last.session = current.session;
        last.model = current.model;
        last.task = current.task;
      }
    } else {
      merged.push(current);
    }
  }
  
  return merged;
}

/**
 * Get attribution info for a specific line
 * @param {string} filePath - Path to the file
 * @param {number} line - Line number (1-indexed)
 */
function getLineAttribution(filePath, line) {
  const relativePath = filePath.replace(/^\//, '');
  const fileData = attributionState.files.get(relativePath);
  if (!fileData) return null;
  
  const range = fileData.ranges.find(r => r.start <= line && r.end >= line);
  return range || null;
}

/**
 * Get all AI-generated lines for a file
 * @param {string} filePath - Path to the file
 */
function getFileAttribution(filePath) {
  const relativePath = filePath.replace(/^\//, '');
  return attributionState.files.get(relativePath) || { ranges: [] };
}

/**
 * Get attribution statistics for a file
 * @param {string} filePath - Path to the file
 * @param {number} totalLines - Total lines in file
 */
function getAttributionStats(filePath, totalLines) {
  const fileData = getFileAttribution(filePath);
  
  let aiLines = 0;
  for (const range of fileData.ranges) {
    aiLines += range.end - range.start + 1;
  }
  
  const humanLines = totalLines - aiLines;
  const aiPercent = totalLines > 0 ? Math.round((aiLines / totalLines) * 100) : 0;
  
  return {
    totalLines,
    aiLines,
    humanLines,
    aiPercent,
    humanPercent: 100 - aiPercent,
    ranges: fileData.ranges.length
  };
}

/**
 * Update the gutter decorations in Monaco editor
 */
function updateAttributionGutter() {
  if (!attributionState.showGutter || !state.editor) return;
  
  const filePath = state.currentFile;
  if (!filePath) return;
  
  const fileData = getFileAttribution(filePath);
  
  // Clear existing decorations
  if (attributionState.decorations.length > 0) {
    state.editor.deltaDecorations(attributionState.decorations, []);
    attributionState.decorations = [];
  }
  
  if (fileData.ranges.length === 0) return;
  
  // Create new decorations
  const newDecorations = [];
  
  for (const range of fileData.ranges) {
    newDecorations.push({
      range: new monaco.Range(range.start, 1, range.end, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName: 'ai-attribution-gutter',
        overviewRuler: {
          color: '#58a6ff44',
          position: monaco.editor.OverviewRulerLane.Left
        },
        minimap: {
          color: '#58a6ff44',
          position: monaco.editor.MinimapPosition.Gutter
        },
        hoverMessage: {
          value: `🤖 **AI Generated**\n\nDate: ${new Date(range.date).toLocaleDateString()}\nModel: ${range.model || 'Clawd'}\n${range.task ? `Task: ${range.task}` : ''}`
        }
      }
    });
  }
  
  attributionState.decorations = state.editor.deltaDecorations([], newDecorations);
}

/**
 * Toggle attribution gutter visibility
 */
function toggleAttributionGutter(show = null) {
  if (show === null) {
    attributionState.showGutter = !attributionState.showGutter;
  } else {
    attributionState.showGutter = show;
  }
  
  localStorage.setItem('attributionShowGutter', attributionState.showGutter.toString());
  
  if (attributionState.showGutter) {
    updateAttributionGutter();
  } else {
    // Clear decorations
    if (state.editor && attributionState.decorations.length > 0) {
      state.editor.deltaDecorations(attributionState.decorations, []);
      attributionState.decorations = [];
    }
  }
  
  showNotification(
    attributionState.showGutter ? '👁 AI attribution visible' : '👁‍🗨 AI attribution hidden',
    'info'
  );
}

/**
 * Filter to show only AI-generated lines (jump between them)
 */
function jumpToNextAICode() {
  if (!state.editor || !state.currentFile) return;
  
  const fileData = getFileAttribution(state.currentFile);
  if (fileData.ranges.length === 0) {
    showNotification('No AI-generated code in this file', 'info');
    return;
  }
  
  const currentLine = state.editor.getPosition()?.lineNumber || 1;
  
  // Find next range after current line
  let nextRange = fileData.ranges.find(r => r.start > currentLine);
  
  // Wrap around if at end
  if (!nextRange) {
    nextRange = fileData.ranges[0];
  }
  
  // Jump to the range
  state.editor.setPosition({ lineNumber: nextRange.start, column: 1 });
  state.editor.revealLineInCenter(nextRange.start);
  
  showNotification(`AI code: lines ${nextRange.start}-${nextRange.end}`, 'info');
}

/**
 * Generate git commit message with AI attribution
 * @param {string[]} files - List of changed files
 */
function generateAttributionCommitMessage(files) {
  const aiFiles = [];
  let totalAILines = 0;
  
  for (const file of files) {
    const stats = getAttributionStats(file, 0); // We don't have total lines here
    if (stats.aiLines > 0) {
      aiFiles.push(file);
      totalAILines += stats.aiLines;
    }
  }
  
  if (aiFiles.length === 0) return null;
  
  return `\n\n🤖 AI-assisted: ${aiFiles.length} file(s), ~${totalAILines} lines\nSession: ${attributionState.currentSession}`;
}

/**
 * Show attribution panel/modal with detailed stats
 */
function showAttributionPanel() {
  const filePath = state.currentFile;
  if (!filePath) {
    showNotification('No file open', 'warning');
    return;
  }
  
  const model = state.editor?.getModel();
  const totalLines = model?.getLineCount() || 0;
  const stats = getAttributionStats(filePath, totalLines);
  const fileData = getFileAttribution(filePath);
  
  let html = `
    <div class="attribution-panel">
      <div class="attribution-header">
        <span class="attribution-icon">📊</span>
        <span class="attribution-title">AI Attribution</span>
      </div>
      <div class="attribution-file">${escapeHtml(filePath)}</div>
      
      <div class="attribution-stats">
        <div class="stat-row">
          <span class="stat-label">Total Lines</span>
          <span class="stat-value">${stats.totalLines}</span>
        </div>
        <div class="stat-row ai">
          <span class="stat-label">🤖 AI Generated</span>
          <span class="stat-value">${stats.aiLines} (${stats.aiPercent}%)</span>
        </div>
        <div class="stat-row human">
          <span class="stat-label">👤 Human Written</span>
          <span class="stat-value">${stats.humanLines} (${stats.humanPercent}%)</span>
        </div>
      </div>
      
      <div class="attribution-bar">
        <div class="attribution-bar-ai" style="width: ${stats.aiPercent}%"></div>
      </div>
  `;
  
  if (fileData.ranges.length > 0) {
    html += `
      <div class="attribution-ranges">
        <div class="ranges-header">AI Code Ranges (${fileData.ranges.length})</div>
    `;
    
    for (const range of fileData.ranges.slice(0, 10)) {
      const date = new Date(range.date).toLocaleDateString();
      html += `
        <div class="range-item" onclick="jumpToLine(${range.start})">
          <span class="range-lines">Lines ${range.start}-${range.end}</span>
          <span class="range-date">${date}</span>
          <span class="range-model">${escapeHtml(range.model || 'clawd')}</span>
        </div>
      `;
    }
    
    if (fileData.ranges.length > 10) {
      html += `<div class="range-more">... and ${fileData.ranges.length - 10} more ranges</div>`;
    }
    
    html += '</div>';
  }
  
  html += `
      <div class="attribution-actions">
        <button onclick="toggleAttributionGutter()">
          ${attributionState.showGutter ? '👁‍🗨 Hide Gutter' : '👁 Show Gutter'}
        </button>
        <button onclick="jumpToNextAICode()">
          ⏭ Next AI Code
        </button>
        <button onclick="exportAttribution()">
          📤 Export
        </button>
      </div>
    </div>
  `;
  
  if (typeof showModal === 'function') {
    showModal('AI Attribution', html);
  } else {
    console.log('Attribution stats:', stats);
  }
}

/**
 * Export attribution data for current file
 */
function exportAttribution() {
  const filePath = state.currentFile;
  if (!filePath) return;
  
  const fileData = getFileAttribution(filePath);
  const model = state.editor?.getModel();
  const stats = getAttributionStats(filePath, model?.getLineCount() || 0);
  
  const exportData = {
    file: filePath,
    exportDate: new Date().toISOString(),
    session: attributionState.currentSession,
    stats,
    ranges: fileData.ranges
  };
  
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `attribution-${filePath.replace(/\//g, '-')}.json`;
  a.click();
  
  URL.revokeObjectURL(url);
}

/**
 * Jump to a specific line
 */
function jumpToLine(line) {
  if (!state.editor) return;
  state.editor.setPosition({ lineNumber: line, column: 1 });
  state.editor.revealLineInCenter(line);
}

// Debounced save
let saveTimeout = null;
function debouncedSaveAttribution() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(saveAttribution, 2000);
}

// Helper
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Export functions
window.initAttribution = initAttribution;
window.recordAICode = recordAICode;
window.recordHumanEdit = recordHumanEdit;
window.getLineAttribution = getLineAttribution;
window.getFileAttribution = getFileAttribution;
window.getAttributionStats = getAttributionStats;
window.updateAttributionGutter = updateAttributionGutter;
window.toggleAttributionGutter = toggleAttributionGutter;
window.jumpToNextAICode = jumpToNextAICode;
window.showAttributionPanel = showAttributionPanel;
window.exportAttribution = exportAttribution;
window.generateAttributionCommitMessage = generateAttributionCommitMessage;
window.jumpToLine = jumpToLine;

// Initialize on load
document.addEventListener('DOMContentLoaded', initAttribution);

// Update gutter when file changes
document.addEventListener('fileOpened', () => {
  setTimeout(updateAttributionGutter, 100);
  setTimeout(updateAttributionStatusBar, 100);
});

/**
 * Update the status bar attribution indicator
 */
function updateAttributionStatusBar() {
  const statusEl = document.getElementById('statusAIPercent');
  if (!statusEl || !state.currentFile) return;
  
  const model = state.editor?.getModel();
  const totalLines = model?.getLineCount() || 0;
  
  if (totalLines === 0) {
    statusEl.textContent = '--%';
    return;
  }
  
  const stats = getAttributionStats(state.currentFile, totalLines);
  statusEl.textContent = `${stats.aiPercent}%`;
  
  // Update tooltip
  const container = document.getElementById('statusAttribution');
  if (container) {
    container.title = `AI Attribution: ${stats.aiLines} of ${stats.totalLines} lines (${stats.aiPercent}%)\nClick for details`;
  }
}

window.updateAttributionStatusBar = updateAttributionStatusBar;

// Also update when editor content changes
if (typeof state !== 'undefined') {
  // Hook into file open
  const originalOpenFile = window.openFile;
  if (originalOpenFile) {
    window.openFile = async function(...args) {
      const result = await originalOpenFile.apply(this, args);
      setTimeout(updateAttributionStatusBar, 200);
      setTimeout(updateAttributionGutter, 200);
      return result;
    };
  }
}
