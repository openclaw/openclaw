// ============================================
// MEMORY SEARCH MODULE - Search DNA Memory from IDE
// ============================================
// Unique feature: Search MEMORY.md + memory/*.md directly from IDE

const memorySearchState = {
  isOpen: false,
  results: [],
  recentSearches: [],
  lastQuery: '',
  searchTimeout: null,
};

/**
 * Initialize memory search module
 */
function initMemorySearch() {
  // Load recent searches from localStorage
  const saved = localStorage.getItem('memoryRecentSearches');
  if (saved) {
    try {
      memorySearchState.recentSearches = JSON.parse(saved);
    } catch (e) {
      memorySearchState.recentSearches = [];
    }
  }
  
  // Register keyboard shortcut
  document.addEventListener('keydown', (e) => {
    // Cmd+Shift+M to open memory search
    if (e.metaKey && e.shiftKey && e.key === 'm') {
      e.preventDefault();
      toggleMemorySearch();
    }
    // Escape to close
    if (e.key === 'Escape' && memorySearchState.isOpen) {
      closeMemorySearch();
    }
  });
  
  console.log('🧠 Memory search initialized');
}

/**
 * Toggle memory search panel visibility
 */
function toggleMemorySearch() {
  if (memorySearchState.isOpen) {
    closeMemorySearch();
  } else {
    openMemorySearch();
  }
}

/**
 * Open memory search panel
 */
function openMemorySearch() {
  let panel = document.getElementById('memorySearchPanel');
  
  // Create panel if it doesn't exist
  if (!panel) {
    panel = createMemorySearchPanel();
    document.body.appendChild(panel);
  }
  
  panel.classList.remove('hidden');
  memorySearchState.isOpen = true;
  
  // Focus input
  const input = document.getElementById('memorySearchInput');
  if (input) {
    input.focus();
    input.select();
  }
  
  // Show recent searches if no query
  if (!memorySearchState.lastQuery) {
    renderRecentSearches();
  }
}

/**
 * Close memory search panel
 */
function closeMemorySearch() {
  const panel = document.getElementById('memorySearchPanel');
  if (panel) {
    panel.classList.add('hidden');
  }
  memorySearchState.isOpen = false;
}

/**
 * Create the memory search panel HTML
 */
function createMemorySearchPanel() {
  const panel = document.createElement('div');
  panel.id = 'memorySearchPanel';
  panel.className = 'memory-search-panel hidden';
  
  panel.innerHTML = `
    <div class="memory-search-overlay" onclick="closeMemorySearch()"></div>
    <div class="memory-search-modal">
      <div class="memory-search-header">
        <span class="memory-search-icon">🧠</span>
        <span class="memory-search-title">Search Memory</span>
        <span class="memory-search-shortcut">⌘⇧M</span>
        <button class="memory-search-close" onclick="closeMemorySearch()">×</button>
      </div>
      <div class="memory-search-input-wrapper">
        <input 
          type="text" 
          id="memorySearchInput" 
          placeholder="What did we decide about... / When did I... / How do I..."
          oninput="handleMemorySearchInput(this.value)"
          onkeydown="handleMemorySearchKeydown(event)"
        />
        <div class="memory-search-loading hidden" id="memorySearchLoading">
          <span class="loading-spinner"></span>
        </div>
      </div>
      <div class="memory-search-results" id="memorySearchResults">
        <div class="memory-search-empty">
          <span class="empty-icon">🔍</span>
          <span class="empty-text">Search your memory files</span>
          <span class="empty-hint">MEMORY.md + daily notes + decisions</span>
        </div>
      </div>
      <div class="memory-search-footer">
        <span class="memory-search-tip">
          <kbd>↵</kbd> to open &nbsp;·&nbsp; 
          <kbd>↑↓</kbd> to navigate &nbsp;·&nbsp; 
          <kbd>esc</kbd> to close
        </span>
      </div>
    </div>
  `;
  
  return panel;
}

/**
 * Handle input changes in search field
 * @param {string} query - Search query
 */
function handleMemorySearchInput(query) {
  // Debounce search
  clearTimeout(memorySearchState.searchTimeout);
  
  if (!query || query.length < 2) {
    renderRecentSearches();
    return;
  }
  
  memorySearchState.lastQuery = query;
  
  // Show loading state
  document.getElementById('memorySearchLoading')?.classList.remove('hidden');
  
  memorySearchState.searchTimeout = setTimeout(async () => {
    await performMemorySearch(query);
  }, 300);
}

/**
 * Handle keyboard navigation in search
 * @param {KeyboardEvent} event
 */
function handleMemorySearchKeydown(event) {
  const results = document.querySelectorAll('.memory-search-result');
  const selected = document.querySelector('.memory-search-result.selected');
  let selectedIndex = Array.from(results).indexOf(selected);
  
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      if (selectedIndex < results.length - 1) {
        results[selectedIndex]?.classList.remove('selected');
        results[selectedIndex + 1]?.classList.add('selected');
        results[selectedIndex + 1]?.scrollIntoView({ block: 'nearest' });
      }
      break;
      
    case 'ArrowUp':
      event.preventDefault();
      if (selectedIndex > 0) {
        results[selectedIndex]?.classList.remove('selected');
        results[selectedIndex - 1]?.classList.add('selected');
        results[selectedIndex - 1]?.scrollIntoView({ block: 'nearest' });
      }
      break;
      
    case 'Enter':
      event.preventDefault();
      if (selected) {
        const filePath = selected.dataset.file;
        const line = parseInt(selected.dataset.line) || 1;
        openMemoryFile(filePath, line);
      }
      break;
  }
}

/**
 * Perform the actual memory search
 * @param {string} query - Search query
 */
async function performMemorySearch(query) {
  try {
    const response = await fetch('/api/memory/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 20 })
    });
    
    const results = await response.json();
    
    document.getElementById('memorySearchLoading')?.classList.add('hidden');
    
    if (results.error) {
      renderSearchError(results.error);
      return;
    }
    
    memorySearchState.results = results.results || [];
    renderSearchResults(memorySearchState.results);
    
    // Save to recent searches
    addToRecentSearches(query);
    
  } catch (error) {
    console.error('Memory search error:', error);
    document.getElementById('memorySearchLoading')?.classList.add('hidden');
    renderSearchError(error.message);
  }
}

/**
 * Render search results
 * @param {Array} results - Search results
 */
function renderSearchResults(results) {
  const container = document.getElementById('memorySearchResults');
  if (!container) return;
  
  if (!results || results.length === 0) {
    container.innerHTML = `
      <div class="memory-search-empty">
        <span class="empty-icon">🤷</span>
        <span class="empty-text">No results found</span>
        <span class="empty-hint">Try different keywords</span>
      </div>
    `;
    return;
  }
  
  let html = '';
  
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const isFirst = i === 0;
    const fileName = r.file?.split('/').pop() || 'Unknown';
    const fileIcon = getMemoryFileIcon(fileName);
    const snippet = highlightMatch(r.snippet || r.content || '', memorySearchState.lastQuery);
    
    html += `
      <div class="memory-search-result ${isFirst ? 'selected' : ''}" 
           data-file="${escapeHtml(r.file || '')}"
           data-line="${r.line || 1}"
           onclick="openMemoryFile('${escapeHtml(r.file || '')}', ${r.line || 1})">
        <div class="result-header">
          <span class="result-icon">${fileIcon}</span>
          <span class="result-file">${escapeHtml(fileName)}</span>
          ${r.line ? `<span class="result-line">:${r.line}</span>` : ''}
          ${r.score ? `<span class="result-score">${Math.round(r.score * 100)}%</span>` : ''}
        </div>
        <div class="result-snippet">${snippet}</div>
        ${r.date ? `<div class="result-date">${escapeHtml(r.date)}</div>` : ''}
      </div>
    `;
  }
  
  container.innerHTML = html;
}

/**
 * Render recent searches
 */
function renderRecentSearches() {
  const container = document.getElementById('memorySearchResults');
  if (!container) return;
  
  if (memorySearchState.recentSearches.length === 0) {
    container.innerHTML = `
      <div class="memory-search-empty">
        <span class="empty-icon">🧠</span>
        <span class="empty-text">Search your memory</span>
        <span class="empty-hint">Find past decisions, notes, and context</span>
      </div>
    `;
    return;
  }
  
  let html = '<div class="memory-search-recent-header">Recent Searches</div>';
  
  for (const search of memorySearchState.recentSearches.slice(0, 5)) {
    html += `
      <div class="memory-search-recent" onclick="setMemorySearchQuery('${escapeHtml(search)}')">
        <span class="recent-icon">🕐</span>
        <span class="recent-query">${escapeHtml(search)}</span>
      </div>
    `;
  }
  
  container.innerHTML = html;
}

/**
 * Render search error
 * @param {string} message - Error message
 */
function renderSearchError(message) {
  const container = document.getElementById('memorySearchResults');
  if (!container) return;
  
  container.innerHTML = `
    <div class="memory-search-empty error">
      <span class="empty-icon">⚠</span>
      <span class="empty-text">Search error</span>
      <span class="empty-hint">${escapeHtml(message)}</span>
    </div>
  `;
}

/**
 * Set the search query programmatically
 * @param {string} query - Query to set
 */
function setMemorySearchQuery(query) {
  const input = document.getElementById('memorySearchInput');
  if (input) {
    input.value = query;
    handleMemorySearchInput(query);
  }
}

/**
 * Open a memory file in the editor
 * @param {string} filePath - Path to the file
 * @param {number} line - Line number to jump to
 */
function openMemoryFile(filePath, line = 1) {
  closeMemorySearch();
  
  // Use IDE's file opening function
  if (typeof openFile === 'function') {
    openFile(filePath).then(() => {
      // Jump to line
      if (typeof goToLine === 'function') {
        goToLine(line);
      } else if (state.editor) {
        state.editor.revealLineInCenter(line);
        state.editor.setPosition({ lineNumber: line, column: 1 });
      }
    });
  } else {
    console.log('Open file:', filePath, 'at line', line);
  }
}

/**
 * Add query to recent searches
 * @param {string} query - Search query
 */
function addToRecentSearches(query) {
  if (!query || query.length < 3) return;
  
  // Remove if exists
  memorySearchState.recentSearches = memorySearchState.recentSearches.filter(s => s !== query);
  
  // Add to front
  memorySearchState.recentSearches.unshift(query);
  
  // Keep only 10
  memorySearchState.recentSearches = memorySearchState.recentSearches.slice(0, 10);
  
  // Save to localStorage
  localStorage.setItem('memoryRecentSearches', JSON.stringify(memorySearchState.recentSearches));
}

/**
 * Get icon for memory file
 * @param {string} fileName - File name
 */
function getMemoryFileIcon(fileName) {
  if (fileName === 'MEMORY.md') return '🧠';
  if (fileName.match(/^\d{4}-\d{2}-\d{2}\.md$/)) return '📅';
  if (fileName.includes('heartbeat')) return '💓';
  if (fileName.includes('workflow')) return '⚙️';
  return '📝';
}

/**
 * Highlight search match in snippet
 * @param {string} text - Text to highlight
 * @param {string} query - Search query
 */
function highlightMatch(text, query) {
  if (!query || !text) return escapeHtml(text);
  
  const escaped = escapeHtml(text);
  const queryWords = query.toLowerCase().split(/\s+/);
  
  let result = escaped;
  for (const word of queryWords) {
    if (word.length < 2) continue;
    const regex = new RegExp(`(${word})`, 'gi');
    result = result.replace(regex, '<mark>$1</mark>');
  }
  
  return result;
}

// Helper to escape HTML
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Export functions
window.initMemorySearch = initMemorySearch;
window.toggleMemorySearch = toggleMemorySearch;
window.openMemorySearch = openMemorySearch;
window.closeMemorySearch = closeMemorySearch;
window.setMemorySearchQuery = setMemorySearchQuery;
window.openMemoryFile = openMemoryFile;

// Initialize on load
document.addEventListener('DOMContentLoaded', initMemorySearch);
