// ============================================
// LAYOUT PRESETS MODULE - Quick Layout Switching
// ============================================
// Agent/Editor/Zen modes with Cmd+Opt+Tab cycling

const layoutState = {
  currentLayout: 'default',
  layouts: {
    default: {
      name: 'Default',
      icon: '⊞',
      sidebar: true,
      sidebarWidth: 250,
      bottomPanel: true,
      bottomPanelHeight: 200,
      rightPanel: false,
      activityBar: true,
      statusBar: true,
      minimap: true,
    },
    agent: {
      name: 'Agent Mode',
      icon: '🤖',
      sidebar: true,
      sidebarWidth: 350,
      sidebarPanel: 'agent', // Force agent panel
      bottomPanel: true,
      bottomPanelHeight: 250,
      bottomPanelTab: 'agent-terminal',
      rightPanel: false,
      activityBar: true,
      statusBar: true,
      minimap: false,
    },
    editor: {
      name: 'Editor Focus',
      icon: '✏️',
      sidebar: true,
      sidebarWidth: 200,
      sidebarPanel: 'explorer',
      bottomPanel: false,
      rightPanel: false,
      activityBar: true,
      statusBar: true,
      minimap: true,
    },
    zen: {
      name: 'Zen Mode',
      icon: '🧘',
      sidebar: false,
      bottomPanel: false,
      rightPanel: false,
      activityBar: false,
      statusBar: false,
      minimap: false,
    },
    split: {
      name: 'Split View',
      icon: '◫',
      sidebar: true,
      sidebarWidth: 200,
      bottomPanel: true,
      bottomPanelHeight: 150,
      rightPanel: true,
      rightPanelWidth: 400,
      rightPanelTab: 'ai',
      activityBar: true,
      statusBar: true,
      minimap: false,
    },
  },
  previousLayout: null,
  history: [],
};

/**
 * Initialize layout presets
 */
function initLayoutPresets() {
  // Load saved layout
  const saved = localStorage.getItem('layoutPreset');
  if (saved && layoutState.layouts[saved]) {
    layoutState.currentLayout = saved;
  }
  
  // Register keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Cmd+Opt+Tab to cycle layouts
    if (e.metaKey && e.altKey && e.key === 'Tab') {
      e.preventDefault();
      cycleLayout();
    }
    
    // Cmd+Opt+1-5 for specific layouts
    if (e.metaKey && e.altKey && e.key >= '1' && e.key <= '5') {
      e.preventDefault();
      const layouts = Object.keys(layoutState.layouts);
      const index = parseInt(e.key) - 1;
      if (layouts[index]) {
        setLayout(layouts[index]);
      }
    }
    
    // Escape in Zen mode returns to previous
    if (e.key === 'Escape' && layoutState.currentLayout === 'zen') {
      setLayout(layoutState.previousLayout || 'default');
    }
  });
  
  // Apply current layout
  applyLayout(layoutState.currentLayout);
  
  console.log('📐 Layout presets initialized');
}

/**
 * Set a specific layout
 * @param {string} layoutName - Name of the layout
 */
function setLayout(layoutName) {
  if (!layoutState.layouts[layoutName]) {
    console.error('Unknown layout:', layoutName);
    return;
  }
  
  layoutState.previousLayout = layoutState.currentLayout;
  layoutState.currentLayout = layoutName;
  layoutState.history.push(layoutName);
  
  // Keep history manageable
  if (layoutState.history.length > 10) {
    layoutState.history = layoutState.history.slice(-10);
  }
  
  localStorage.setItem('layoutPreset', layoutName);
  applyLayout(layoutName);
  
  const layout = layoutState.layouts[layoutName];
  showNotification(`${layout.icon} ${layout.name}`, 'info');
}

/**
 * Cycle to next layout
 */
function cycleLayout() {
  const layouts = Object.keys(layoutState.layouts);
  const currentIndex = layouts.indexOf(layoutState.currentLayout);
  const nextIndex = (currentIndex + 1) % layouts.length;
  setLayout(layouts[nextIndex]);
}

/**
 * Apply a layout configuration
 * @param {string} layoutName - Name of the layout
 */
function applyLayout(layoutName) {
  const layout = layoutState.layouts[layoutName];
  if (!layout) return;
  
  // Sidebar
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.style.display = layout.sidebar ? 'flex' : 'none';
    if (layout.sidebarWidth) {
      sidebar.style.width = layout.sidebarWidth + 'px';
    }
  }
  
  // Activity bar
  const activityBar = document.querySelector('.activity-bar');
  if (activityBar) {
    activityBar.style.display = layout.activityBar ? 'flex' : 'none';
  }
  
  // Bottom panel
  const bottomPanel = document.getElementById('bottomPanelContainer');
  if (bottomPanel) {
    bottomPanel.style.display = layout.bottomPanel ? 'flex' : 'none';
    if (layout.bottomPanelHeight) {
      bottomPanel.style.height = layout.bottomPanelHeight + 'px';
    }
  }
  
  // Right panel
  const rightPanel = document.getElementById('rightPanelContainer');
  if (rightPanel) {
    if (layout.rightPanel) {
      rightPanel.classList.remove('hidden');
      if (layout.rightPanelWidth) {
        rightPanel.style.width = layout.rightPanelWidth + 'px';
      }
    } else {
      rightPanel.classList.add('hidden');
    }
  }
  
  // Status bar
  const statusBar = document.getElementById('statusBar');
  if (statusBar) {
    statusBar.style.display = layout.statusBar ? 'flex' : 'none';
  }
  
  // Show/hide zen mode exit button
  showZenExitButton(layoutName === 'zen');
  
  // Minimap
  if (state.editor) {
    state.editor.updateOptions({ minimap: { enabled: layout.minimap } });
  }
  
  // Switch to specific panel if specified
  if (layout.sidebarPanel && typeof switchPanel === 'function') {
    switchPanel(layout.sidebarPanel);
  }
  
  // Switch bottom panel tab if specified
  if (layout.bottomPanelTab && typeof switchBottomPanel === 'function') {
    switchBottomPanel(layout.bottomPanelTab);
  }
  
  // Switch right panel tab if specified
  if (layout.rightPanelTab && typeof switchRightPanel === 'function') {
    switchRightPanel(layout.rightPanelTab);
  }
  
  // Update layout indicator
  updateLayoutIndicator();
  
  // Trigger resize to refit editor
  window.dispatchEvent(new Event('resize'));
}

/**
 * Toggle Zen mode
 */
function toggleZenMode() {
  if (layoutState.currentLayout === 'zen') {
    setLayout(layoutState.previousLayout || 'default');
  } else {
    setLayout('zen');
  }
}

/**
 * Show/hide zen mode exit button
 * @param {boolean} show - Whether to show the button
 */
function showZenExitButton(show) {
  let btn = document.getElementById('zenExitButton');
  
  if (show) {
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'zenExitButton';
      btn.className = 'zen-exit-button';
      btn.innerHTML = '🧘 Exit Zen <kbd>Esc</kbd>';
      btn.title = 'Exit Zen Mode (or press Escape)';
      btn.onclick = () => setLayout(layoutState.previousLayout || 'default');
      
      // Add styles
      const style = document.createElement('style');
      style.id = 'zenExitStyles';
      style.textContent = `
        .zen-exit-button {
          position: fixed;
          top: 16px;
          right: 16px;
          z-index: 10000;
          padding: 8px 16px;
          background: rgba(30, 30, 46, 0.9);
          border: 1px solid rgba(139, 92, 246, 0.5);
          border-radius: 8px;
          color: #fff;
          font-size: 13px;
          cursor: pointer;
          display: flex;
          align-items: center;
          gap: 8px;
          opacity: 0.3;
          transition: opacity 0.2s, transform 0.2s;
          backdrop-filter: blur(8px);
        }
        
        .zen-exit-button:hover {
          opacity: 1;
          transform: scale(1.02);
          background: rgba(139, 92, 246, 0.3);
        }
        
        .zen-exit-button kbd {
          padding: 2px 6px;
          background: rgba(255,255,255,0.1);
          border-radius: 4px;
          font-size: 11px;
          font-family: inherit;
        }
      `;
      
      if (!document.getElementById('zenExitStyles')) {
        document.head.appendChild(style);
      }
      document.body.appendChild(btn);
    }
    btn.style.display = 'flex';
  } else {
    if (btn) {
      btn.style.display = 'none';
    }
  }
}

/**
 * Update the layout indicator in status bar
 */
function updateLayoutIndicator() {
  const indicator = document.getElementById('layoutIndicator');
  if (!indicator) return;
  
  const layout = layoutState.layouts[layoutState.currentLayout];
  indicator.innerHTML = `<span>${layout.icon}</span> <span>${layout.name}</span>`;
  indicator.title = `Layout: ${layout.name}\nCmd+Opt+Tab to cycle`;
}

/**
 * Show layout picker modal
 */
function showLayoutPicker() {
  let modal = document.getElementById('layoutPickerModal');
  
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'layoutPickerModal';
    modal.className = 'layout-picker-modal hidden';
    modal.innerHTML = createLayoutPickerHTML();
    document.body.appendChild(modal);
  }
  
  modal.classList.remove('hidden');
  
  // Close on click outside
  modal.querySelector('.layout-picker-overlay').onclick = hideLayoutPicker;
}

/**
 * Hide layout picker modal
 */
function hideLayoutPicker() {
  const modal = document.getElementById('layoutPickerModal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

/**
 * Create layout picker HTML
 */
function createLayoutPickerHTML() {
  let itemsHTML = '';
  const layouts = Object.entries(layoutState.layouts);
  
  layouts.forEach(([key, layout], index) => {
    const isActive = key === layoutState.currentLayout;
    itemsHTML += `
      <div class="layout-picker-item ${isActive ? 'active' : ''}" onclick="setLayout('${key}'); hideLayoutPicker();">
        <span class="layout-icon">${layout.icon}</span>
        <span class="layout-name">${layout.name}</span>
        <span class="layout-shortcut">⌘⌥${index + 1}</span>
      </div>
    `;
  });
  
  return `
    <div class="layout-picker-overlay"></div>
    <div class="layout-picker-content">
      <div class="layout-picker-header">
        <span>📐 Layout Presets</span>
        <span class="layout-picker-hint">⌘⌥Tab to cycle</span>
      </div>
      <div class="layout-picker-items">
        ${itemsHTML}
      </div>
    </div>
  `;
}

/**
 * Get current layout name
 */
function getCurrentLayout() {
  return layoutState.currentLayout;
}

/**
 * Save custom layout
 * @param {string} name - Layout name
 */
function saveCurrentAsLayout(name) {
  const customLayout = {
    name: name,
    icon: '⭐',
    sidebar: document.getElementById('sidebar')?.style.display !== 'none',
    sidebarWidth: parseInt(document.getElementById('sidebar')?.style.width) || 250,
    bottomPanel: document.getElementById('bottomPanelContainer')?.style.display !== 'none',
    bottomPanelHeight: parseInt(document.getElementById('bottomPanelContainer')?.style.height) || 200,
    rightPanel: !document.getElementById('rightPanelContainer')?.classList.contains('hidden'),
    activityBar: document.querySelector('.activity-bar')?.style.display !== 'none',
    statusBar: document.getElementById('statusBar')?.style.display !== 'none',
    minimap: state.editor?.getOption(monaco.editor.EditorOption.minimap)?.enabled ?? true,
  };
  
  const key = 'custom-' + name.toLowerCase().replace(/\s+/g, '-');
  layoutState.layouts[key] = customLayout;
  
  // Save to localStorage
  localStorage.setItem('customLayouts', JSON.stringify(
    Object.entries(layoutState.layouts)
      .filter(([k]) => k.startsWith('custom-'))
      .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {})
  ));
  
  showNotification(`✓ Layout "${name}" saved`, 'success');
}

// Load custom layouts on init
function loadCustomLayouts() {
  try {
    const custom = JSON.parse(localStorage.getItem('customLayouts') || '{}');
    Object.assign(layoutState.layouts, custom);
  } catch (e) {
    console.error('Failed to load custom layouts:', e);
  }
}

/**
 * Emergency reset - restore all UI elements
 * Call this if UI is stuck/hidden
 */
function emergencyResetLayout() {
  console.log('🚨 Emergency layout reset triggered');
  
  // Force show all major UI elements
  const elements = {
    'sidebar': 'flex',
    'statusBar': 'flex',
    'bottomPanelContainer': 'flex',
  };
  
  Object.entries(elements).forEach(([id, display]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = display;
  });
  
  const activityBar = document.querySelector('.activity-bar');
  if (activityBar) activityBar.style.display = 'flex';
  
  // Hide zen exit button
  const zenBtn = document.getElementById('zenExitButton');
  if (zenBtn) zenBtn.style.display = 'none';
  
  // Reset state
  layoutState.currentLayout = 'default';
  localStorage.setItem('layoutPreset', 'default');
  
  // Trigger resize
  window.dispatchEvent(new Event('resize'));
  
  if (window.showNotification) {
    showNotification('⊞ Layout reset to default', 'success');
  }
}

// Triple-Escape emergency exit (press Escape 3 times quickly)
let escapeCount = 0;
let escapeTimer = null;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    escapeCount++;
    clearTimeout(escapeTimer);
    
    if (escapeCount >= 3) {
      escapeCount = 0;
      emergencyResetLayout();
    } else {
      escapeTimer = setTimeout(() => { escapeCount = 0; }, 500);
    }
  }
});

// Export functions
window.initLayoutPresets = initLayoutPresets;
window.setLayout = setLayout;
window.cycleLayout = cycleLayout;
window.toggleZenMode = toggleZenMode;
window.showLayoutPicker = showLayoutPicker;
window.hideLayoutPicker = hideLayoutPicker;
window.getCurrentLayout = getCurrentLayout;
window.saveCurrentAsLayout = saveCurrentAsLayout;
window.emergencyResetLayout = emergencyResetLayout;

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
  loadCustomLayouts();
  initLayoutPresets();
});
