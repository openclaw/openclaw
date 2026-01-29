// ============================================
// DNA MEMORY MODULE
// ============================================
// Integrates DNA's memory system into the IDE

const memoryState = {
  context: null,
  files: [],
  searchResults: [],
  currentFile: null,
  panelVisible: false,
};

// Load memory context for display
async function loadMemoryContext() {
  try {
    const res = await fetch('/api/memory/context');
    memoryState.context = await res.json();
    renderMemoryPanel();
    return memoryState.context;
  } catch (err) {
    console.error('Failed to load memory context:', err);
    return null;
  }
}

// Load list of memory files
async function loadMemoryFiles() {
  try {
    const res = await fetch('/api/memory/list');
    const data = await res.json();
    memoryState.files = data.files || [];
    return memoryState.files;
  } catch (err) {
    console.error('Failed to load memory files:', err);
    return [];
  }
}

// Read a specific memory file
async function readMemoryFile(name) {
  try {
    const res = await fetch(`/api/memory/file?name=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error('File not found');
    const data = await res.json();
    return data.content;
  } catch (err) {
    console.error('Failed to read memory file:', err);
    return null;
  }
}

// Save a memory file
async function saveMemoryFile(name, content) {
  try {
    const res = await fetch('/api/memory/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content })
    });
    const data = await res.json();
    if (data.success) {
      showNotification('Memory saved!', 'success');
    }
    return data.success;
  } catch (err) {
    showNotification('Failed to save memory', 'error');
    return false;
  }
}

// Add a quick note
async function addMemoryNote(note, category = null) {
  try {
    const res = await fetch('/api/memory/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note, category })
    });
    const data = await res.json();
    if (data.success) {
      showNotification('Note added!', 'success');
      loadMemoryContext(); // Refresh
    }
    return data.success;
  } catch (err) {
    showNotification('Failed to add note', 'error');
    return false;
  }
}

// Search memory
async function searchMemory(query) {
  try {
    const res = await fetch(`/api/memory/search?query=${encodeURIComponent(query)}`);
    const data = await res.json();
    memoryState.searchResults = data.results || [];
    return memoryState.searchResults;
  } catch (err) {
    console.error('Failed to search memory:', err);
    return [];
  }
}

// Get AI-enriched context (for sending with requests)
async function getAIContext(maxTokens = 2000) {
  try {
    const res = await fetch(`/api/memory/ai-context?maxTokens=${maxTokens}`);
    const data = await res.json();
    return data.context || '';
  } catch (err) {
    console.error('Failed to get AI context:', err);
    return '';
  }
}

// Toggle memory panel visibility
function toggleMemoryPanel() {
  memoryState.panelVisible = !memoryState.panelVisible;
  const panel = document.getElementById('memoryPanel');
  if (panel) {
    panel.classList.toggle('visible', memoryState.panelVisible);
  }
  if (memoryState.panelVisible && !memoryState.context) {
    loadMemoryContext();
    loadMemoryFiles();
  }
}

// Render the memory panel
function renderMemoryPanel() {
  const panel = document.getElementById('memoryPanel');
  if (!panel) return;
  
  const ctx = memoryState.context || {};
  
  let html = `
    <div class="memory-panel-content">
      <div class="memory-header">
        <h3>🧠 DNA Memory</h3>
        <button onclick="toggleMemoryPanel()" class="memory-close">×</button>
      </div>
      
      <!-- Quick Note Input -->
      <div class="memory-quick-note">
        <input type="text" id="quickNoteInput" placeholder="Add a quick note..." 
               onkeydown="if(event.key==='Enter') addQuickNote()">
        <button onclick="addQuickNote()" title="Add note">+</button>
      </div>
      
      <!-- Search -->
      <div class="memory-search">
        <input type="text" id="memorySearchInput" placeholder="Search memory..." 
               onkeydown="if(event.key==='Enter') performMemorySearch()">
        <button onclick="performMemorySearch()" title="Search">🔍</button>
      </div>
      
      <!-- Context Display -->
      <div class="memory-sections">
        ${ctx.dailyNotes?.length ? `
          <div class="memory-section">
            <div class="memory-section-header" onclick="toggleMemorySection(this)">
              <span>📅 Recent Notes</span>
              <span class="memory-section-toggle">▼</span>
            </div>
            <div class="memory-section-content">
              ${ctx.dailyNotes.map(note => `
                <div class="memory-note" onclick="openMemoryFile('memory/${note.date}.md')">
                  <div class="memory-note-date">${note.date}</div>
                  <div class="memory-note-preview">${escapeHtml(note.content.slice(0, 150))}...</div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
        
        ${ctx.memory ? `
          <div class="memory-section">
            <div class="memory-section-header" onclick="toggleMemorySection(this)">
              <span>🧠 Long-term Memory</span>
              <span class="memory-section-toggle">▼</span>
            </div>
            <div class="memory-section-content">
              <div class="memory-preview" onclick="openMemoryFile('MEMORY.md')">
                ${escapeHtml(ctx.memory.slice(0, 300))}...
              </div>
            </div>
          </div>
        ` : ''}
        
        ${ctx.project ? `
          <div class="memory-section">
            <div class="memory-section-header" onclick="toggleMemorySection(this)">
              <span>📦 Project Context</span>
              <span class="memory-section-toggle">▼</span>
            </div>
            <div class="memory-section-content">
              <div class="memory-project">
                <div><strong>Name:</strong> ${ctx.project.name || 'Unknown'}</div>
                ${ctx.project.description ? `<div><strong>Description:</strong> ${ctx.project.description}</div>` : ''}
                ${ctx.project.dependencies?.length ? `
                  <div><strong>Dependencies:</strong> ${ctx.project.dependencies.slice(0, 10).join(', ')}${ctx.project.dependencies.length > 10 ? '...' : ''}</div>
                ` : ''}
              </div>
            </div>
          </div>
        ` : ''}
      </div>
      
      <!-- Memory Files List -->
      <div class="memory-files">
        <div class="memory-files-header">
          <span>📁 Memory Files</span>
          <button onclick="loadMemoryFiles()" title="Refresh" class="memory-refresh">↻</button>
        </div>
        <div class="memory-files-list" id="memoryFilesList">
          ${renderMemoryFilesList()}
        </div>
      </div>
    </div>
  `;
  
  panel.innerHTML = html;
}

function renderMemoryFilesList() {
  // Check if editing - if so, don't re-render
  if (editingFile) return document.getElementById('memoryFilesList')?.innerHTML || '';
  
  return memoryState.files.map(f => {
    // Only show edit button for writable files
    const canEdit = ['MEMORY.md', 'TOOLS.md', 'HEARTBEAT.md'].includes(f.name) || f.type === 'daily';
    return `
      <div class="memory-file-item ${f.type}">
        <span class="memory-file-icon" onclick="openMemoryFile('${f.path}')">${f.type === 'core' ? '📄' : '📅'}</span>
        <span class="memory-file-name" onclick="openMemoryFile('${f.path}')">${f.name}</span>
        <span class="memory-file-size">${formatFileSize(f.size)}</span>
        ${canEdit ? `<button class="memory-file-edit" onclick="event.stopPropagation(); editMemoryInline('${f.path}')" title="Edit inline">✏️</button>` : ''}
      </div>
    `;
  }).join('') || '<div class="memory-empty">No memory files found</div>';
}

function toggleMemorySection(header) {
  const content = header.nextElementSibling;
  const toggle = header.querySelector('.memory-section-toggle');
  content.classList.toggle('collapsed');
  toggle.textContent = content.classList.contains('collapsed') ? '▶' : '▼';
}

async function addQuickNote() {
  const input = document.getElementById('quickNoteInput');
  const note = input?.value.trim();
  if (!note) return;
  
  await addMemoryNote(note);
  input.value = '';
}

async function performMemorySearch() {
  const input = document.getElementById('memorySearchInput');
  const query = input?.value.trim();
  if (!query) return;
  
  const results = await searchMemory(query);
  showMemorySearchResults(results);
}

function showMemorySearchResults(results) {
  const container = document.getElementById('memoryFilesList');
  if (!container) return;
  
  if (results.length === 0) {
    container.innerHTML = '<div class="memory-empty">No results found</div>';
    return;
  }
  
  container.innerHTML = results.map(r => `
    <div class="memory-search-result" onclick="openMemoryFile('${r.file}', ${r.line})">
      <div class="memory-result-file">${r.file}:${r.line}</div>
      <div class="memory-result-content">${escapeHtml(r.content)}</div>
    </div>
  `).join('');
}

async function openMemoryFile(name, line = null) {
  // Open in the editor
  const content = await readMemoryFile(name);
  if (content !== null) {
    // Use the existing file opening mechanism
    if (typeof openFile === 'function') {
      // Create a virtual file path for memory files
      const virtualPath = name.startsWith('memory/') ? name : name;
      
      // Check if we can open it in the editor
      const editorTab = state.tabs.find(t => t.path === virtualPath);
      if (editorTab) {
        switchToTab(editorTab.id);
      } else {
        // Open as new tab
        createTab(virtualPath, content);
        if (line && state.editor) {
          state.editor.revealLineInCenter(line);
          state.editor.setPosition({ lineNumber: line, column: 1 });
        }
      }
    }
    memoryState.currentFile = name;
  }
}

// Inline editing state
let editingFile = null;
let originalContent = null;

// Start inline editing a memory file
async function editMemoryInline(filename) {
  const content = await readMemoryFile(filename);
  if (content === null) return;
  
  editingFile = filename;
  originalContent = content;
  
  // Show editor in the panel
  const container = document.getElementById('memoryFilesList');
  if (!container) return;
  
  container.innerHTML = `
    <div class="memory-inline-editor">
      <div class="memory-editor-title">
        <span>Editing: ${filename}</span>
      </div>
      <textarea class="memory-editor" id="memoryEditorTextarea">${escapeHtml(content)}</textarea>
      <div class="memory-editor-actions">
        <button class="save-btn" onclick="saveMemoryInline()">Save</button>
        <button class="cancel-btn" onclick="cancelMemoryEdit()">Cancel</button>
      </div>
    </div>
  `;
  
  // Focus the textarea
  setTimeout(() => {
    const textarea = document.getElementById('memoryEditorTextarea');
    if (textarea) textarea.focus();
  }, 50);
}

// Save inline edits
async function saveMemoryInline() {
  if (!editingFile) return;
  
  const textarea = document.getElementById('memoryEditorTextarea');
  const newContent = textarea?.value || '';
  
  const success = await saveMemoryFile(editingFile, newContent);
  if (success) {
    editingFile = null;
    originalContent = null;
    // Refresh the file list
    await loadMemoryFiles();
    renderMemoryFilesList();
    loadMemoryContext(); // Refresh context display
  }
}

// Cancel inline editing
function cancelMemoryEdit() {
  editingFile = null;
  originalContent = null;
  // Restore file list
  const container = document.getElementById('memoryFilesList');
  if (container) {
    container.innerHTML = renderMemoryFilesList();
  }
}

// Helper to escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Helper to format file size
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Initialize memory panel on page load
function initMemoryPanel() {
  // Create the panel element if it doesn't exist
  if (!document.getElementById('memoryPanel')) {
    const panel = document.createElement('div');
    panel.id = 'memoryPanel';
    panel.className = 'memory-panel';
    document.body.appendChild(panel);
  }
  
  // Add memory indicator to AI chat header
  setTimeout(() => {
    updateMemoryIndicator();
  }, 500);
}

// Update memory indicator in AI chat and status bar
function updateMemoryIndicator() {
  // Check if memory is enabled
  const settings = typeof currentSettings !== 'undefined' ? currentSettings : { memory: { includeInChat: true } };
  const isEnabled = settings.memory?.includeInChat !== false;
  
  // Update AI header indicator
  const aiHeader = document.querySelector('#panel-ai .sidebar-header');
  if (aiHeader) {
    let indicator = document.getElementById('memoryIndicator');
    if (!indicator) {
      indicator = document.createElement('span');
      indicator.id = 'memoryIndicator';
      indicator.className = 'memory-indicator';
      indicator.onclick = toggleMemoryPanel;
      aiHeader.appendChild(indicator);
    }
    
    indicator.innerHTML = '🧠';
    indicator.className = `memory-indicator ${isEnabled ? 'active' : 'inactive'}`;
    indicator.title = isEnabled ? 'Memory active - click to open panel' : 'Memory disabled - click to enable';
  }
  
  // Update status bar indicator
  const statusMemory = document.getElementById('statusMemory');
  const statusMemoryText = document.getElementById('statusMemoryText');
  if (statusMemory) {
    statusMemory.className = `status-item memory-status ${isEnabled ? 'active' : 'inactive'}`;
    statusMemory.title = isEnabled ? 'Memory active (click to open)' : 'Memory disabled';
  }
  if (statusMemoryText) {
    statusMemoryText.textContent = isEnabled ? 'Memory ✓' : 'Memory ✗';
  }
}

// Check if memory should be included in chat
function isMemoryEnabled() {
  const settings = typeof currentSettings !== 'undefined' ? currentSettings : { memory: { includeInChat: true } };
  return settings.memory?.includeInChat !== false;
}

// Export to window
window.memoryState = memoryState;
window.loadMemoryContext = loadMemoryContext;
window.loadMemoryFiles = loadMemoryFiles;
window.readMemoryFile = readMemoryFile;
window.saveMemoryFile = saveMemoryFile;
window.addMemoryNote = addMemoryNote;
window.searchMemory = searchMemory;
window.getAIContext = getAIContext;
window.toggleMemoryPanel = toggleMemoryPanel;
window.initMemoryPanel = initMemoryPanel;
window.openMemoryFile = openMemoryFile;
window.addQuickNote = addQuickNote;
window.performMemorySearch = performMemorySearch;
window.toggleMemorySection = toggleMemorySection;
window.updateMemoryIndicator = updateMemoryIndicator;
window.isMemoryEnabled = isMemoryEnabled;
window.editMemoryInline = editMemoryInline;
window.saveMemoryInline = saveMemoryInline;
window.cancelMemoryEdit = cancelMemoryEdit;
