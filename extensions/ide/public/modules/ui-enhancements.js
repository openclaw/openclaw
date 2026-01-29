// ============================================
// UI ENHANCEMENTS MODULE
// Phases 2-4: Visual Polish & Advanced Features
// ============================================

// ============================================
// THEME SYSTEM
// ============================================

const themes = ['dark', 'light', 'midnight', 'forest'];
let currentTheme = localStorage.getItem('theme') || 'dark';

function initTheme() {
  document.documentElement.setAttribute('data-theme', currentTheme);
  updateThemeUI();
}

function setTheme(theme) {
  if (!themes.includes(theme)) return;
  currentTheme = theme;
  localStorage.setItem('theme', theme);
  document.documentElement.setAttribute('data-theme', theme);
  updateThemeUI();
  showToast('Theme changed', `Switched to ${theme} theme`, 'success');
}

function cycleTheme() {
  const currentIndex = themes.indexOf(currentTheme);
  const nextIndex = (currentIndex + 1) % themes.length;
  setTheme(themes[nextIndex]);
}

function updateThemeUI() {
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) {
    themeSelect.value = currentTheme;
  }
}

// ============================================
// KEYBOARD SHORTCUT OVERLAY
// ============================================

const shortcuts = {
  'General': [
    { keys: ['⌘', 'K'], label: 'Command Palette' },
    { keys: ['⌘', 'P'], label: 'Quick Open File' },
    { keys: ['⌘', 'S'], label: 'Save File' },
    { keys: ['⌘', 'W'], label: 'Close Tab' },
    { keys: ['⌘', '?'], label: 'Show Shortcuts' },
    { keys: ['⌘', ','], label: 'Settings' },
  ],
  'Editor': [
    { keys: ['⌘', 'F'], label: 'Find' },
    { keys: ['⌘', 'H'], label: 'Find & Replace' },
    { keys: ['⌘', 'G'], label: 'Go to Line' },
    { keys: ['⌘', 'D'], label: 'Select Word' },
    { keys: ['⌘', '/'], label: 'Toggle Comment' },
    { keys: ['⌥', '↑'], label: 'Move Line Up' },
    { keys: ['⌥', '↓'], label: 'Move Line Down' },
    { keys: ['⌘', '⇧', 'K'], label: 'Delete Line' },
  ],
  'AI Features': [
    { keys: ['⌘', 'K'], label: 'Inline Edit' },
    { keys: ['⌘', 'L'], label: 'Open AI Chat' },
    { keys: ['⌘', '⇧', 'G'], label: 'Agent Mode' },
    { keys: ['Tab'], label: 'Accept Completion' },
    { keys: ['Esc'], label: 'Dismiss Completion' },
  ],
  'Navigation': [
    { keys: ['⌘', 'B'], label: 'Toggle Sidebar' },
    { keys: ['⌘', 'J'], label: 'Toggle Terminal' },
    { keys: ['⌘', '1-9'], label: 'Go to Tab' },
    { keys: ['⌘', '⇧', 'E'], label: 'Explorer' },
    { keys: ['⌘', '⇧', 'F'], label: 'Search' },
    { keys: ['⌘', '⇧', 'D'], label: 'Debug' },
  ],
  'Terminal': [
    { keys: ['⌘', '`'], label: 'Toggle Terminal' },
    { keys: ['⌘', '⇧', '`'], label: 'New Terminal' },
    { keys: ['⌘', '\\\\'], label: 'Split Terminal' },
    { keys: ['⌃', 'C'], label: 'Cancel Command' },
    { keys: ['⌃', 'L'], label: 'Clear Terminal' },
  ],
};

let shortcutOverlayVisible = false;

function toggleShortcutOverlay() {
  shortcutOverlayVisible = !shortcutOverlayVisible;
  const overlay = document.getElementById('shortcutOverlay');
  if (overlay) {
    overlay.classList.toggle('visible', shortcutOverlayVisible);
  } else {
    createShortcutOverlay();
  }
}

function createShortcutOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'shortcutOverlay';
  overlay.className = 'shortcut-overlay visible';
  overlay.onclick = (e) => {
    if (e.target === overlay) toggleShortcutOverlay();
  };
  
  const modal = document.createElement('div');
  modal.className = 'shortcut-modal';
  modal.innerHTML = `
    <div class="shortcut-modal-header">
      <div class="shortcut-modal-title">⌨️ Keyboard Shortcuts</div>
      <button class="shortcut-modal-close" onclick="toggleShortcutOverlay()">×</button>
    </div>
    <div class="shortcut-sections">
      ${Object.entries(shortcuts).map(([section, items]) => `
        <div class="shortcut-section">
          <div class="shortcut-section-title">${section}</div>
          <div class="shortcut-list">
            ${items.map(item => `
              <div class="shortcut-item">
                <span class="shortcut-label">${item.label}</span>
                <span class="shortcut-keys">
                  ${item.keys.map(key => `<span class="shortcut-key">${key}</span>`).join('')}
                </span>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
  
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  shortcutOverlayVisible = true;
}

// ============================================
// COLLAPSIBLE SECTIONS
// ============================================

function initCollapsibleSections() {
  // Add click handlers to section headers
  document.querySelectorAll('.sidebar-section-header').forEach(header => {
    header.onclick = () => {
      const section = header.closest('.sidebar-section');
      if (section) {
        section.classList.toggle('collapsed');
        // Save state
        const sectionId = section.dataset.section;
        if (sectionId) {
          const collapsed = JSON.parse(localStorage.getItem('collapsedSections') || '{}');
          collapsed[sectionId] = section.classList.contains('collapsed');
          localStorage.setItem('collapsedSections', JSON.stringify(collapsed));
        }
      }
    };
  });
  
  // Restore saved state
  const collapsed = JSON.parse(localStorage.getItem('collapsedSections') || '{}');
  Object.entries(collapsed).forEach(([sectionId, isCollapsed]) => {
    const section = document.querySelector(`.sidebar-section[data-section="${sectionId}"]`);
    if (section && isCollapsed) {
      section.classList.add('collapsed');
    }
  });
}

// ============================================
// FILE TREE DEPTH TRACKING
// ============================================

function setFileItemDepth(element, depth) {
  element.style.setProperty('--depth', depth);
  element.dataset.depth = depth;
}

function renderFileTreeWithDepth(files, container, depth = 0) {
  files.forEach(file => {
    const item = document.createElement('div');
    item.className = 'file-item';
    setFileItemDepth(item, depth);
    
    if (file.isDirectory) {
      item.dataset.hasChildren = 'true';
      item.innerHTML = `
        <span class="folder-icon">▶</span>
        <span class="file-icon">📁</span>
        <span class="file-name">${escapeHtml(file.name)}</span>
      `;
      
      const children = document.createElement('div');
      children.className = 'file-children';
      
      item.onclick = (e) => {
        e.stopPropagation();
        item.classList.toggle('expanded');
        children.classList.toggle('visible');
      };
      
      container.appendChild(item);
      container.appendChild(children);
      
      if (file.children) {
        renderFileTreeWithDepth(file.children, children, depth + 1);
      }
    } else {
      item.innerHTML = `
        <span class="file-icon">${getFileIcon(file.name)}</span>
        <span class="file-name">${escapeHtml(file.name)}</span>
      `;
      item.onclick = () => openFile(file.path);
      container.appendChild(item);
    }
  });
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================

let toastContainer = null;

function initToasts() {
  toastContainer = document.createElement('div');
  toastContainer.className = 'toast-container';
  document.body.appendChild(toastContainer);
}

function showToast(title, message, type = 'info', duration = 5000) {
  if (!toastContainer) initToasts();
  
  const icons = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  };
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type]}</span>
    <div class="toast-content">
      <div class="toast-title">${escapeHtml(title)}</div>
      ${message ? `<div class="toast-message">${escapeHtml(message)}</div>` : ''}
    </div>
    <button class="toast-close" onclick="this.parentElement.remove()">×</button>
    <div class="toast-progress">
      <div class="toast-progress-bar" style="animation-duration: ${duration}ms"></div>
    </div>
  `;
  
  toastContainer.appendChild(toast);
  
  // Auto remove
  setTimeout(() => {
    toast.classList.add('exiting');
    setTimeout(() => toast.remove(), 150);
  }, duration);
  
  return toast;
}

// ============================================
// VIM MODE (OPTIONAL)
// ============================================

let vimModeEnabled = localStorage.getItem('vimMode') === 'true';
let vimMode = 'normal'; // normal, insert, visual, command

function initVimMode() {
  if (!vimModeEnabled) return;
  
  // Create indicator
  const indicator = document.createElement('div');
  indicator.id = 'vimModeIndicator';
  indicator.className = 'vim-mode-indicator visible normal';
  indicator.textContent = '-- NORMAL --';
  document.body.appendChild(indicator);
  
  // Add vim keybindings to Monaco
  if (typeof monaco !== 'undefined' && state.editor) {
    // This would integrate with Monaco's vim extension
    // For now, just show the indicator
  }
}

function setVimMode(mode) {
  vimMode = mode;
  const indicator = document.getElementById('vimModeIndicator');
  if (indicator) {
    indicator.className = `vim-mode-indicator visible ${mode}`;
    indicator.textContent = `-- ${mode.toUpperCase()} --`;
  }
}

function toggleVimMode() {
  vimModeEnabled = !vimModeEnabled;
  localStorage.setItem('vimMode', vimModeEnabled);
  
  const indicator = document.getElementById('vimModeIndicator');
  if (vimModeEnabled) {
    initVimMode();
    showToast('Vim Mode', 'Vim keybindings enabled', 'success');
  } else {
    if (indicator) indicator.remove();
    showToast('Vim Mode', 'Vim keybindings disabled', 'info');
  }
}

// ============================================
// CHAT PANEL ENHANCEMENTS
// ============================================

function renderChatMessage(message) {
  const isUser = message.role === 'user';
  const time = new Date(message.timestamp || Date.now()).toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit' 
  });
  
  return `
    <div class="chat-message ${isUser ? 'user' : 'assistant'}">
      <div class="chat-message-avatar">
        ${isUser ? '👤' : '🐾'}
      </div>
      <div class="chat-message-body">
        <div class="chat-message-header">
          <span class="chat-message-sender">${isUser ? 'You' : 'Clawd'}</span>
          <span class="chat-message-time">${time}</span>
        </div>
        <div class="chat-message-content">
          ${formatMessageContent(message.content)}
        </div>
      </div>
    </div>
  `;
}

function formatMessageContent(content) {
  // Convert markdown-style code blocks to styled HTML
  let formatted = escapeHtml(content);
  
  // Code blocks with language
  formatted = formatted.replace(/```(\w+)?\n([\s\S]*?)```/g, (match, lang, code) => {
    return `
      <div class="code-block-wrapper">
        <div class="code-block-header">
          <span>${lang || 'code'}</span>
          <div class="code-block-actions">
            <button class="code-action-btn" onclick="copyCodeBlock(this)">Copy</button>
            <button class="code-action-btn primary" onclick="insertCodeBlock(this)">Insert</button>
          </div>
        </div>
        <pre><code>${code.trim()}</code></pre>
      </div>
    `;
  });
  
  // Inline code
  formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // Bold
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  // Italic
  formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  
  // Line breaks
  formatted = formatted.replace(/\n/g, '<br>');
  
  return formatted;
}

function copyCodeBlock(button) {
  const code = button.closest('.code-block-wrapper').querySelector('code').textContent;
  navigator.clipboard.writeText(code);
  button.textContent = 'Copied!';
  setTimeout(() => button.textContent = 'Copy', 2000);
}

function insertCodeBlock(button) {
  const code = button.closest('.code-block-wrapper').querySelector('code').textContent;
  if (state.editor) {
    const selection = state.editor.getSelection();
    state.editor.executeEdits('insert-code', [{
      range: selection,
      text: code,
      forceMoveMarkers: true
    }]);
  }
}

// ============================================
// SKELETON LOADING
// ============================================

function showFileTreeSkeleton() {
  const container = document.getElementById('fileTree');
  if (!container) return;
  
  container.innerHTML = `
    <div class="skeleton-file-tree">
      ${Array(8).fill(0).map((_, i) => `
        <div class="skeleton-file-item" style="padding-left: ${(i % 3) * 16}px">
          <div class="skeleton skeleton-file-icon"></div>
          <div class="skeleton skeleton-file-name" style="width: ${50 + Math.random() * 40}%"></div>
        </div>
      `).join('')}
    </div>
  `;
}

function showChatSkeleton() {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  
  container.innerHTML = `
    <div class="chat-message assistant">
      <div class="skeleton skeleton-avatar"></div>
      <div class="chat-message-body">
        <div class="skeleton skeleton-text short"></div>
        <div class="skeleton skeleton-text long"></div>
        <div class="skeleton skeleton-text medium"></div>
      </div>
    </div>
  `;
}

// ============================================
// TYPING INDICATOR
// ============================================

function showTypingIndicator() {
  const container = document.getElementById('chatMessages');
  if (!container) return;
  
  // Remove existing
  container.querySelector('.typing-indicator')?.remove();
  
  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  indicator.innerHTML = `
    <div class="typing-dots">
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
      <div class="typing-dot"></div>
    </div>
    <span>Clawd is thinking...</span>
  `;
  
  container.appendChild(indicator);
  container.scrollTop = container.scrollHeight;
}

function hideTypingIndicator() {
  document.querySelector('.typing-indicator')?.remove();
}

// ============================================
// CONTEXT MENU ENHANCEMENTS
// ============================================

function showContextMenu(x, y, items) {
  // Remove existing
  document.querySelector('.context-menu')?.remove();
  
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  
  menu.innerHTML = items.map(item => {
    if (item.separator) {
      return '<div class="context-menu-separator"></div>';
    }
    return `
      <div class="context-menu-item ${item.danger ? 'danger' : ''}" onclick="${item.action}; hideContextMenu()">
        <span class="context-menu-item-icon">${item.icon || ''}</span>
        <span class="context-menu-item-label">${item.label}</span>
        ${item.shortcut ? `<span class="context-menu-item-shortcut">${item.shortcut}</span>` : ''}
      </div>
    `;
  }).join('');
  
  document.body.appendChild(menu);
  
  // Adjust position if off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    menu.style.left = `${x - rect.width}px`;
  }
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${y - rect.height}px`;
  }
  
  // Close on click outside
  setTimeout(() => {
    document.addEventListener('click', hideContextMenu, { once: true });
  }, 0);
}

function hideContextMenu() {
  document.querySelector('.context-menu')?.remove();
}

// ============================================
// INITIALIZATION
// ============================================

function initUIEnhancements() {
  // Theme
  initTheme();
  
  // Collapsible sections
  initCollapsibleSections();
  
  // Toasts
  initToasts();
  
  // Vim mode
  if (vimModeEnabled) initVimMode();
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Cmd+? for shortcuts
    if ((e.metaKey || e.ctrlKey) && e.key === '?') {
      e.preventDefault();
      toggleShortcutOverlay();
    }
    // Escape to close overlay
    if (e.key === 'Escape' && shortcutOverlayVisible) {
      toggleShortcutOverlay();
    }
  });
  
  console.log('✨ UI Enhancements initialized');
}

// Auto-init when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUIEnhancements);
} else {
  initUIEnhancements();
}

// Export for global use
window.setTheme = setTheme;
window.cycleTheme = cycleTheme;
window.toggleShortcutOverlay = toggleShortcutOverlay;
window.toggleVimMode = toggleVimMode;
window.showToast = showToast;
window.showContextMenu = showContextMenu;
window.hideContextMenu = hideContextMenu;
window.showTypingIndicator = showTypingIndicator;
window.hideTypingIndicator = hideTypingIndicator;
window.renderChatMessage = renderChatMessage;
window.copyCodeBlock = copyCodeBlock;
window.insertCodeBlock = insertCodeBlock;
