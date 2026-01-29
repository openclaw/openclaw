// ============================================
// KEYBINDINGS MODULE - Custom Keyboard Shortcuts
// ============================================

const KeybindingsManager = {
  // Default keybindings - ID, key combo, description, action
  defaults: [
    // General
    { id: 'commandPalette', keys: 'Cmd+K', desc: 'Command Palette / Inline Edit', action: 'showCommandPalette' },
    { id: 'quickOpen', keys: 'Cmd+P', desc: 'Quick Open File', action: 'openQuickOpen' },
    { id: 'settings', keys: 'Cmd+,', desc: 'Settings', action: 'showSettings' },
    { id: 'shortcuts', keys: 'Cmd+?', desc: 'Keyboard Shortcuts', action: 'showKeyboardShortcuts' },
    
    // File
    { id: 'save', keys: 'Cmd+S', desc: 'Save File', action: 'saveCurrentFile' },
    { id: 'saveAll', keys: 'Cmd+Alt+S', desc: 'Save All Files', action: 'saveAllFiles' },
    { id: 'closeTab', keys: 'Cmd+W', desc: 'Close Tab', action: 'closeActiveTab' },
    { id: 'newFile', keys: 'Cmd+N', desc: 'New File', action: 'createNewFile' },
    
    // Editor
    { id: 'find', keys: 'Cmd+F', desc: 'Find in File', action: 'toggleFindWidget' },
    { id: 'replace', keys: 'Cmd+H', desc: 'Find and Replace', action: 'toggleReplaceWidget' },
    { id: 'globalSearch', keys: 'Cmd+Shift+F', desc: 'Search in Files', action: 'openGlobalSearch' },
    { id: 'goToLine', keys: 'Cmd+G', desc: 'Go to Line', action: 'goToLine' },
    { id: 'undo', keys: 'Cmd+Z', desc: 'Undo', action: 'editorUndo' },
    { id: 'redo', keys: 'Cmd+Shift+Z', desc: 'Redo', action: 'editorRedo' },
    
    // View
    { id: 'toggleSidebar', keys: 'Cmd+B', desc: 'Toggle Sidebar', action: 'toggleSidebar' },
    { id: 'toggleTerminal', keys: 'Cmd+`', desc: 'Toggle Terminal', action: 'toggleTerminal' },
    { id: 'toggleTerminalAlt', keys: 'Cmd+J', desc: 'Toggle Terminal (Alt)', action: 'toggleTerminal' },
    { id: 'focusExplorer', keys: 'Cmd+Shift+E', desc: 'Focus Explorer', action: 'focusExplorer' },
    { id: 'focusBrowser', keys: 'Cmd+Shift+B', desc: 'Focus Browser', action: 'showPanel_browser' },
    { id: 'focusDebug', keys: 'Cmd+Shift+D', desc: 'Focus Debug', action: 'showPanel_debug' },
    { id: 'focusGit', keys: 'Cmd+Shift+G', desc: 'Focus Git', action: 'showPanel_git' },
    
    // Panes
    { id: 'splitHorizontal', keys: 'Cmd+\\', desc: 'Split Pane Right', action: 'splitPaneHorizontal' },
    { id: 'splitVertical', keys: 'Cmd+Shift+\\', desc: 'Split Pane Down', action: 'splitPaneVertical' },
    { id: 'focusPane1', keys: 'Cmd+1', desc: 'Focus Pane 1', action: 'focusPane1' },
    { id: 'focusPane2', keys: 'Cmd+2', desc: 'Focus Pane 2', action: 'focusPane2' },
    { id: 'focusPane3', keys: 'Cmd+3', desc: 'Focus Pane 3', action: 'focusPane3' },
    { id: 'focusPane4', keys: 'Cmd+4', desc: 'Focus Pane 4', action: 'focusPane4' },
    
    // Terminal
    { id: 'newTerminal', keys: 'Cmd+Shift+N', desc: 'New Terminal', action: 'createNewTerminal' },
    { id: 'splitTerminalH', keys: 'Ctrl+Shift+5', desc: 'Split Terminal Horizontal', action: 'splitTerminalHorizontal' },
    { id: 'splitTerminalV', keys: 'Ctrl+Shift+\\', desc: 'Split Terminal Vertical', action: 'splitTerminalVertical' },
    
    // AI
    { id: 'inlineEdit', keys: 'Cmd+K', desc: 'Inline AI Edit', action: 'showInlineEdit' },
    { id: 'codeActions', keys: 'Cmd+.', desc: 'Code Actions (Quick Fix)', action: 'showCodeActions' },
    { id: 'aiChat', keys: 'Cmd+Shift+A', desc: 'Focus AI Chat', action: 'focusAIChat' },
    { id: 'memoryPanel', keys: 'Cmd+M', desc: 'Memory Panel', action: 'showMemoryPanel' },
    
    // Debug
    { id: 'startDebug', keys: 'F5', desc: 'Start/Continue Debugging', action: 'startOrContinueDebug' },
    { id: 'stopDebug', keys: 'Shift+F5', desc: 'Stop Debugging', action: 'stopDebugging' },
    { id: 'stepOver', keys: 'F10', desc: 'Step Over', action: 'stepOver' },
    { id: 'stepInto', keys: 'F11', desc: 'Step Into', action: 'stepInto' },
    { id: 'stepOut', keys: 'Shift+F11', desc: 'Step Out', action: 'stepOut' },
    { id: 'toggleBreakpoint', keys: 'F9', desc: 'Toggle Breakpoint', action: 'toggleBreakpointAtCursor' },
  ],
  
  // Custom overrides (from localStorage)
  custom: {},
  
  // Initialize
  init() {
    this.load();
    console.log('[Keybindings] Initialized with', Object.keys(this.custom).length, 'custom bindings');
  },
  
  // Get effective keybinding for an action
  get(id) {
    return this.custom[id] || this.defaults.find(d => d.id === id)?.keys || null;
  },
  
  // Get all keybindings (merged defaults + custom)
  getAll() {
    return this.defaults.map(d => ({
      ...d,
      keys: this.custom[d.id] || d.keys,
      isCustom: !!this.custom[d.id]
    }));
  },
  
  // Set custom keybinding
  set(id, keys) {
    if (!keys || keys.trim() === '') {
      delete this.custom[id];
    } else {
      this.custom[id] = keys;
    }
    this.save();
  },
  
  // Reset a keybinding to default
  reset(id) {
    delete this.custom[id];
    this.save();
  },
  
  // Reset all keybindings
  resetAll() {
    this.custom = {};
    this.save();
  },
  
  // Save to localStorage
  save() {
    localStorage.setItem('clawd-ide-keybindings', JSON.stringify(this.custom));
  },
  
  // Load from localStorage
  load() {
    try {
      this.custom = JSON.parse(localStorage.getItem('clawd-ide-keybindings') || '{}');
    } catch (e) {
      this.custom = {};
    }
  },
  
  // Parse key string to Monaco key code
  parseKeys(keyString) {
    if (!keyString) return null;
    
    let keyCode = 0;
    const parts = keyString.split('+').map(p => p.trim().toLowerCase());
    
    for (const part of parts) {
      switch (part) {
        case 'cmd':
        case 'meta':
          keyCode |= monaco.KeyMod.CtrlCmd;
          break;
        case 'ctrl':
          keyCode |= monaco.KeyMod.WinCtrl;
          break;
        case 'shift':
          keyCode |= monaco.KeyMod.Shift;
          break;
        case 'alt':
        case 'option':
          keyCode |= monaco.KeyMod.Alt;
          break;
        default:
          // Letter keys
          if (part.length === 1 && part >= 'a' && part <= 'z') {
            keyCode |= monaco.KeyCode['Key' + part.toUpperCase()];
          }
          // F keys
          else if (part.match(/^f(\d+)$/)) {
            keyCode |= monaco.KeyCode['F' + part.substring(1)];
          }
          // Special keys
          else {
            const specialKeys = {
              'enter': monaco.KeyCode.Enter,
              'escape': monaco.KeyCode.Escape,
              'esc': monaco.KeyCode.Escape,
              'backspace': monaco.KeyCode.Backspace,
              'delete': monaco.KeyCode.Delete,
              'tab': monaco.KeyCode.Tab,
              'space': monaco.KeyCode.Space,
              '\\': monaco.KeyCode.Backslash,
              '/': monaco.KeyCode.Slash,
              '.': monaco.KeyCode.Period,
              ',': monaco.KeyCode.Comma,
              '`': monaco.KeyCode.Backquote,
              '-': monaco.KeyCode.Minus,
              '=': monaco.KeyCode.Equal,
              '[': monaco.KeyCode.BracketLeft,
              ']': monaco.KeyCode.BracketRight,
              '?': monaco.KeyCode.Slash, // Shift+/ = ?
              'up': monaco.KeyCode.UpArrow,
              'down': monaco.KeyCode.DownArrow,
              'left': monaco.KeyCode.LeftArrow,
              'right': monaco.KeyCode.RightArrow,
            };
            
            if (specialKeys[part]) {
              keyCode |= specialKeys[part];
            }
          }
      }
    }
    
    return keyCode;
  }
};

// ============================================
// KEYBINDINGS EDITOR UI
// ============================================

function showKeybindingsEditor() {
  // Close any existing modal
  const existing = document.querySelector('.keybindings-modal');
  if (existing) existing.remove();
  
  const keybindings = KeybindingsManager.getAll();
  
  // Group by category
  const categories = {
    'General': ['commandPalette', 'quickOpen', 'settings', 'shortcuts'],
    'File': ['save', 'saveAll', 'closeTab', 'newFile'],
    'Editor': ['find', 'replace', 'globalSearch', 'goToLine', 'undo', 'redo'],
    'View': ['toggleSidebar', 'toggleTerminal', 'toggleTerminalAlt', 'focusExplorer', 'focusBrowser', 'focusDebug', 'focusGit'],
    'Panes': ['splitHorizontal', 'splitVertical', 'focusPane1', 'focusPane2', 'focusPane3', 'focusPane4'],
    'Terminal': ['newTerminal', 'splitTerminalH', 'splitTerminalV'],
    'AI': ['inlineEdit', 'codeActions', 'aiChat', 'memoryPanel'],
    'Debug': ['startDebug', 'stopDebug', 'stepOver', 'stepInto', 'stepOut', 'toggleBreakpoint']
  };
  
  let html = `
    <div class="keybindings-modal">
      <div class="keybindings-content">
        <div class="keybindings-header">
          <h2>⌨️ Keyboard Shortcuts</h2>
          <div class="keybindings-actions">
            <input type="text" id="keybindingsSearch" placeholder="Search shortcuts..." oninput="filterKeybindings(this.value)">
            <button class="btn-secondary" onclick="KeybindingsManager.resetAll(); showKeybindingsEditor();">Reset All</button>
            <button class="btn-close" onclick="closeKeybindingsEditor()">×</button>
          </div>
        </div>
        <div class="keybindings-body">
  `;
  
  for (const [category, ids] of Object.entries(categories)) {
    html += `<div class="keybinding-category" data-category="${category}">
      <div class="keybinding-category-header">${category}</div>`;
    
    for (const id of ids) {
      const kb = keybindings.find(k => k.id === id);
      if (!kb) continue;
      
      html += `
        <div class="keybinding-row" data-id="${kb.id}" data-desc="${kb.desc.toLowerCase()}">
          <span class="keybinding-desc">${kb.desc}</span>
          <div class="keybinding-input-wrapper">
            <input type="text" 
                   class="keybinding-input ${kb.isCustom ? 'custom' : ''}" 
                   value="${kb.keys}" 
                   data-id="${kb.id}"
                   data-default="${KeybindingsManager.defaults.find(d => d.id === kb.id)?.keys || ''}"
                   onfocus="startRecordingKeybinding(this)"
                   onblur="stopRecordingKeybinding(this)"
                   readonly>
            ${kb.isCustom ? `<button class="keybinding-reset" onclick="resetKeybinding('${kb.id}', this)" title="Reset to default">↺</button>` : ''}
          </div>
        </div>
      `;
    }
    
    html += '</div>';
  }
  
  html += `
        </div>
        <div class="keybindings-footer">
          <span class="keybindings-hint">Click a shortcut and press new keys to change it</span>
        </div>
      </div>
    </div>
  `;
  
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('keybindingsSearch')?.focus();
}

function closeKeybindingsEditor() {
  document.querySelector('.keybindings-modal')?.remove();
}

function filterKeybindings(query) {
  const rows = document.querySelectorAll('.keybinding-row');
  const q = query.toLowerCase();
  
  rows.forEach(row => {
    const desc = row.dataset.desc || '';
    const matches = desc.includes(q) || row.dataset.id.toLowerCase().includes(q);
    row.style.display = matches ? '' : 'none';
  });
  
  // Hide empty categories
  document.querySelectorAll('.keybinding-category').forEach(cat => {
    const visibleRows = cat.querySelectorAll('.keybinding-row[style=""]').length ||
                        cat.querySelectorAll('.keybinding-row:not([style])').length;
    cat.style.display = visibleRows > 0 ? '' : 'none';
  });
}

let recordingInput = null;

function startRecordingKeybinding(input) {
  recordingInput = input;
  input.value = 'Press keys...';
  input.classList.add('recording');
  
  document.addEventListener('keydown', recordKeybinding);
}

function stopRecordingKeybinding(input) {
  if (recordingInput === input) {
    recordingInput = null;
    input.classList.remove('recording');
    
    // Restore original value if nothing recorded
    if (input.value === 'Press keys...') {
      const id = input.dataset.id;
      input.value = KeybindingsManager.get(id);
    }
    
    document.removeEventListener('keydown', recordKeybinding);
  }
}

function recordKeybinding(e) {
  if (!recordingInput) return;
  
  e.preventDefault();
  e.stopPropagation();
  
  // Ignore lone modifier keys
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
  
  // Build key string
  const parts = [];
  if (e.metaKey) parts.push('Cmd');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  
  // Handle key
  let key = e.key;
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  else if (key.startsWith('Arrow')) key = key.replace('Arrow', '');
  
  parts.push(key);
  
  const keyString = parts.join('+');
  const id = recordingInput.dataset.id;
  
  // Save the new keybinding
  KeybindingsManager.set(id, keyString);
  
  recordingInput.value = keyString;
  recordingInput.classList.add('custom');
  recordingInput.classList.remove('recording');
  
  // Add reset button if not present
  const wrapper = recordingInput.parentElement;
  if (!wrapper.querySelector('.keybinding-reset')) {
    wrapper.insertAdjacentHTML('beforeend', 
      `<button class="keybinding-reset" onclick="resetKeybinding('${id}', this)" title="Reset to default">↺</button>`
    );
  }
  
  recordingInput.blur();
  recordingInput = null;
  
  document.removeEventListener('keydown', recordKeybinding);
  
  showNotification(`Shortcut updated: ${keyString}`, 'success');
}

function resetKeybinding(id, btn) {
  KeybindingsManager.reset(id);
  
  const row = btn.closest('.keybinding-row');
  const input = row.querySelector('.keybinding-input');
  input.value = input.dataset.default;
  input.classList.remove('custom');
  btn.remove();
  
  showNotification('Shortcut reset to default', 'info');
}

// ============================================
// EXPORTS
// ============================================

window.KeybindingsManager = KeybindingsManager;
window.showKeybindingsEditor = showKeybindingsEditor;
window.closeKeybindingsEditor = closeKeybindingsEditor;
window.filterKeybindings = filterKeybindings;
window.startRecordingKeybinding = startRecordingKeybinding;
window.stopRecordingKeybinding = stopRecordingKeybinding;
window.resetKeybinding = resetKeybinding;
